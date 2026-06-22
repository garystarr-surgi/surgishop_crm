"""
surgishop_crm/api/ringcentral.py

Whitelisted Frappe API methods called by rc_widget.js.

Endpoints:
  - log_call             : creates a CRM Call Log, links to Contact/Lead
  - match_call_logs      : returns already-logged session IDs (dedup)
  - search_contacts      : contact lookup for widget address book
  - match_contacts       : phone-number → contact name resolution (caller ID)
  - find_record_by_phone : screen pop — returns URL + display name for a number
"""

import re
import frappe
from frappe import _
from frappe.utils import now_datetime, cstr


# ── Helpers ──────────────────────────────────────────────────────────────────

def _digits_only(phone: str) -> str:
    """Strip everything except digits, return last 10."""
    return re.sub(r'\D', '', phone or '')[-10:]


def _find_contact_by_phone(phone: str):
    """
    Search tabContact Phone for a matching number.
    Returns (contact_name, full_name) or (None, None).
    """
    digits = _digits_only(phone)
    if not digits:
        return None, None

    result = frappe.db.sql("""
        SELECT
            cp.parent        AS name,
            CONCAT(c.first_name, ' ', IFNULL(c.last_name, '')) AS full_name
        FROM `tabContact Phone` cp
        JOIN `tabContact` c ON c.name = cp.parent
        WHERE REGEXP_REPLACE(cp.phone, '[^0-9]', '') LIKE %s
        LIMIT 1
    """, ('%' + digits,), as_dict=True)

    if result:
        return result[0].name, result[0].full_name.strip()
    return None, None


def _find_lead_by_phone(phone: str):
    """
    Search CRM Lead for a matching mobile_no or phone.
    Returns (lead_name, lead_fullname) or (None, None).
    """
    digits = _digits_only(phone)
    if not digits:
        return None, None

    result = frappe.db.sql("""
        SELECT
            name,
            CONCAT(IFNULL(first_name,''), ' ', IFNULL(last_name,'')) AS full_name
        FROM `tabCRM Lead`
        WHERE REGEXP_REPLACE(mobile_no, '[^0-9]', '') LIKE %s
           OR REGEXP_REPLACE(phone,     '[^0-9]', '') LIKE %s
        LIMIT 1
    """, ('%' + digits, '%' + digits), as_dict=True)

    if result:
        return result[0].name, result[0].full_name.strip()
    return None, None


def _find_customer_by_phone(phone: str):
    """
    Search Customer for a matching phone number via Contact links.
    Returns (customer_name, customer_name_str) or (None, None).
    """
    digits = _digits_only(phone)
    if not digits:
        return None, None

    result = frappe.db.sql("""
        SELECT dl.link_name AS name, dl.link_name AS full_name
        FROM `tabContact Phone` cp
        JOIN `tabContact` c  ON c.name = cp.parent
        JOIN `tabDynamic Link` dl ON dl.parent = c.name
            AND dl.link_doctype = 'Customer'
        WHERE REGEXP_REPLACE(cp.phone, '[^0-9]', '') LIKE %s
        LIMIT 1
    """, ('%' + digits,), as_dict=True)

    if result:
        return result[0].name, result[0].full_name
    return None, None


# ── 1. Log Call ───────────────────────────────────────────────────────────────

@frappe.whitelist()
def log_call(session_id, from_number, from_name, to_number, to_name,
             direction, duration, call_status, start_time='',
             recording_id='', recording_url=''):
    """
    Called by rc_widget.js when a call ends (auto-log or manual log button).
    Creates a CRM Call Log document linked to a Contact or Lead if found.
    Returns the new document name, or existing name if already logged.
    """

    # ── Dedup: skip if this session was already logged ──
    existing = frappe.db.get_value('CRM Call Log', {'id': session_id}, 'name')
    if existing:
        return existing

    # ── Determine which number to look up ──
    lookup_number = from_number if direction == 'Inbound' else to_number

    contact_name, _ = _find_contact_by_phone(lookup_number)
    lead_name,    _ = (None, None)
    if not contact_name:
        lead_name, _ = _find_lead_by_phone(lookup_number)

    # ── Map RC status → CRM status ──
    status_map = {
        'CallConnected': 'Completed',
        'Completed':     'Completed',
        'NoAnswer':      'No Answer',
        'Busy':          'Busy',
        'Voicemail':     'Voicemail',
        'Rejected':      'No Answer',
        'Missed':        'No Answer',
    }
    mapped_status = status_map.get(call_status, 'Completed')

    # ── Build document ──
    doc = frappe.get_doc({
        'doctype':       'CRM Call Log',
        'id':            session_id,
        'from':          from_number,
        'to':            to_number,
        'type':          direction,
        'duration':      int(float(duration or 0)),
        'status':        mapped_status,
        'start_time':    start_time or now_datetime(),
        'recording_url': recording_url or '',
    })

    if contact_name:
        doc.contact = contact_name
    if lead_name:
        doc.lead = lead_name

    doc.insert(ignore_permissions=True)
    frappe.db.commit()

    return doc.name


# ── 2. Match Call Logs (dedup check for widget) ───────────────────────────────

@frappe.whitelist()
def match_call_logs(session_ids):
    """
    Given a list of RC session IDs, return a dict of
    { sessionId: [{ id, note }] } for any that are already logged.
    The widget uses this to show a checkmark on already-logged calls.
    """
    if isinstance(session_ids, str):
        import json
        session_ids = json.loads(session_ids)

    if not session_ids:
        return {}

    # Build placeholders for SQL IN clause
    placeholders = ', '.join(['%s'] * len(session_ids))
    rows = frappe.db.sql("""
        SELECT id AS session_id, name
        FROM `tabCRM Call Log`
        WHERE id IN ({})
    """.format(placeholders), session_ids, as_dict=True)

    result = {}
    for row in rows:
        result[row.session_id] = [{
            'id':   row.name,
            'note': 'Logged to SurgiShop CRM',
        }]

    return result


# ── 3. Search Contacts (widget address book / dialer search) ──────────────────

@frappe.whitelist()
def search_contacts(query):
    """
    Called when a user types in the RC widget's dialer search box.
    Returns a list of contacts in RC Embeddable contact format.
    """
    if not query or len(query) < 2:
        return []

    like = '%' + query + '%'

    # Search Contacts
    contacts = frappe.db.sql("""
        SELECT
            c.name,
            CONCAT(c.first_name, ' ', IFNULL(c.last_name,'')) AS full_name,
            c.company_name,
            cp.phone
        FROM `tabContact` c
        JOIN `tabContact Phone` cp ON cp.parent = c.name
        WHERE (
            c.first_name LIKE %s OR
            c.last_name  LIKE %s OR
            c.company_name LIKE %s OR
            cp.phone       LIKE %s
        )
        LIMIT 20
    """, (like, like, like, like), as_dict=True)

    result = []
    for c in contacts:
        result.append({
            'id':          c.name,
            'name':        c.full_name.strip() or c.name,
            'type':        'Contact',
            'company':     c.company_name or '',
            'phoneNumbers': [{'phoneNumber': c.phone, 'phoneType': 'direct'}],
        })

    # Also search CRM Leads
    leads = frappe.db.sql("""
        SELECT name,
               CONCAT(IFNULL(first_name,''), ' ', IFNULL(last_name,'')) AS full_name,
               company_name,
               mobile_no, phone
        FROM `tabCRM Lead`
        WHERE first_name LIKE %s OR last_name LIKE %s
           OR company_name LIKE %s
           OR mobile_no    LIKE %s OR phone LIKE %s
        LIMIT 10
    """, (like, like, like, like, like), as_dict=True)

    for l in leads:
        phones = []
        if l.mobile_no:
            phones.append({'phoneNumber': l.mobile_no, 'phoneType': 'mobile'})
        if l.phone:
            phones.append({'phoneNumber': l.phone, 'phoneType': 'direct'})
        if phones:
            result.append({
                'id':           l.name,
                'name':         l.full_name.strip() or l.name,
                'type':         'Lead',
                'company':      l.company_name or '',
                'phoneNumbers': phones,
            })

    return result


# ── 4. Match Contacts (caller ID resolution) ──────────────────────────────────

@frappe.whitelist()
def match_contacts(phone_numbers):
    """
    Widget sends a list of phone numbers from its call history.
    We return a dict of { phoneNumber: [{ id, name, type, phoneNumbers }] }
    so the widget can display caller names instead of raw numbers.
    """
    if isinstance(phone_numbers, str):
        import json
        phone_numbers = json.loads(phone_numbers)

    if not phone_numbers:
        return {}

    result = {}
    for number in phone_numbers:
        contact_name, full_name = _find_contact_by_phone(number)
        if contact_name:
            result[number] = [{
                'id':           contact_name,
                'name':         full_name or contact_name,
                'type':         'Contact',
                'phoneNumbers': [{'phoneNumber': number, 'phoneType': 'direct'}],
            }]
            continue

        lead_name, lead_fullname = _find_lead_by_phone(number)
        if lead_name:
            result[number] = [{
                'id':           lead_name,
                'name':         lead_fullname or lead_name,
                'type':         'Lead',
                'phoneNumbers': [{'phoneNumber': number, 'phoneType': 'mobile'}],
            }]

    return result


# ── 5. Find Record by Phone (screen pop) ─────────────────────────────────────

@frappe.whitelist()
def find_record_by_phone(phone_number):
    """
    Called by screen pop on inbound ringing call.
    Returns { display_name, url } for the best matching record,
    or None if no match found.
    """
    # Try Contact first
    contact_name, full_name = _find_contact_by_phone(phone_number)
    if contact_name:
        return {
            'display_name': full_name or contact_name,
            'url':          '/crm/contacts/' + contact_name,
            'doctype':      'Contact',
            'name':         contact_name,
        }

    # Try Lead
    lead_name, lead_fullname = _find_lead_by_phone(phone_number)
    if lead_name:
        return {
            'display_name': lead_fullname or lead_name,
            'url':          '/crm/leads/' + lead_name,
            'doctype':      'CRM Lead',
            'name':         lead_name,
        }

    # Try Customer via Contact link
    customer_name, customer_str = _find_customer_by_phone(phone_number)
    if customer_name:
        return {
            'display_name': customer_str or customer_name,
            'url':          '/app/customer/' + customer_name,
            'doctype':      'Customer',
            'name':         customer_name,
        }

    return None
