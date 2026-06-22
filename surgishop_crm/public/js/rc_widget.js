/**
 * surgishop_crm/public/js/rc_widget.js
 *
 * RingCentral Embeddable integration for Frappe CRM / ERPNext
 *
 * Provides:
 *   1. Widget injection (softphone in bottom-right corner)
 *   2. Service registration (enables call logging button in widget)
 *   3. C2D library (hover-to-dial on any phone number on the page)
 *   4. Manual dial buttons on CRM Lead / Contact / Customer pages
 *   5. Screen pop on inbound ringing calls
 *   6. Auto call logging to Frappe CRM Call Log doctype
 *
 * Prerequisites:
 *   - Register a REST API App at https://developers.ringcentral.com
 *   - Auth: 3-legged OAuth, Client-side SPA, PKCE (no client secret needed)
 *   - Redirect URI: https://apps.ringcentral.com/integration/ringcentral-embeddable/latest/redirect.html
 *   - Replace RC_CLIENT_ID below with your registered app's Client ID
 */

(function () {
  'use strict';

  // ─── CONFIGURATION ──────────────────────────────────────────────────────────

  var RC_CLIENT_ID = '4kv6Zgevxa2cpSpbOpieOD'; // ← replace this
  var SERVICE_NAME = 'SurgiShopCRM';
  var FRAPPE_SITE  = window.location.origin;    // e.g. https://crm.surgishop.com

  // Only run on desk/CRM pages, skip login page
  if (
    window.location.pathname === '/login' ||
    window.location.pathname === '/'
  ) return;

  // Guard against double-injection (multiple Frappe page navigations)
  if (window._rcWidgetLoaded) return;
  window._rcWidgetLoaded = true;

  // ─── 1. INJECT RC EMBEDDABLE ADAPTER ────────────────────────────────────────
  // PKCE is automatic when only clientId is provided (no clientSecret)
  // defaultAutoLogCallEnabled=1 turns on auto-log by default for all users

  (function () {
    var rcs = document.createElement('script');
    rcs.src = 'https://apps.ringcentral.com/integration/ringcentral-embeddable/latest/adapter.js'
      + '?clientId=' + RC_CLIENT_ID
      + '&defaultAutoLogCallEnabled=1'
      + '&disableInactiveTabCallEvent=1';  // only fire events in the active tab
    document.getElementsByTagName('script')[0].parentNode
      .insertBefore(rcs, document.getElementsByTagName('script')[0]);
  })();

  // ─── 2. INJECT C2D (CLICK-TO-DIAL) LIBRARY ──────────────────────────────────
  // Scans the page for phone numbers and adds a hover dial icon

  var c2dScript = document.createElement('script');
  c2dScript.src = 'https://unpkg.com/ringcentral-c2d@1.0.0/build/index.js';
  c2dScript.onload = function () {
    var clickToDial = new RingCentralC2D();

    clickToDial.on(RingCentralC2D.events.call, function (phoneNumber) {
      if (window.RCAdapter) {
        RCAdapter.clickToCall(phoneNumber, true);
      }
    });

    clickToDial.on(RingCentralC2D.events.text, function (phoneNumber) {
      if (window.RCAdapter) {
        RCAdapter.clickToSMS(phoneNumber);
      }
    });
  };
  document.head.appendChild(c2dScript);

  // ─── 3. SERVICE REGISTRATION + ALL MESSAGE HANDLING ─────────────────────────
  // Must wait for widget login-status before registering service.
  // All postMessage events from the widget are handled in one listener.

  var serviceRegistered = false;

  window.addEventListener('message', function (e) {
    var data = e.data;
    if (!data || !data.type) return;

    switch (data.type) {

      // ── Register service once widget reports login status ──────────────────
      case 'rc-login-status-notify':
        if (!serviceRegistered) {
          serviceRegistered = true;
          _registerService();
        }
        break;

      // ── Screen pop: navigate to contact on inbound ringing call ───────────
      case 'rc-active-call-notify':
        if (
          data.call &&
          data.call.direction === 'Inbound' &&
          data.call.telephonyStatus === 'Ringing'
        ) {
          _handleScreenPop(data.call);
        }
        break;

      // ── Handle requests from the widget (call logging, entity match) ───────
      case 'rc-post-message-request':
        _handleWidgetRequest(data);
        break;

      default:
        break;
    }
  });

  // ─── 4. REGISTER SERVICE WITH WIDGET ────────────────────────────────────────

  function _registerService() {
    var frame = document.querySelector('#rc-widget-adapter-frame');
    if (!frame) return;

    frame.contentWindow.postMessage({
      type: 'rc-adapter-register-third-party-service',
      service: {
        name: SERVICE_NAME,

        // Call logging — adds "Log to SurgiShopCRM" button in call history
        callLoggerPath:              '/callLogger',
        callLoggerTitle:             'Log to SurgiShop CRM',
        callLogEntityMatcherPath:    '/callLogger/match',
        // recordingWithToken: 1,    // uncomment to get recording URL with token

        // Contact lookup — widget resolves caller names from Frappe contacts
        contactsPath:                '/contacts',
        contactSearchPath:           '/contacts/search',
        contactMatchPath:            '/contacts/match',
      }
    }, '*');
  }

  // ─── 5. ROUTE WIDGET REQUESTS ────────────────────────────────────────────────

  function _handleWidgetRequest(data) {
    var path = data.path;

    if (path === '/callLogger') {
      _logCall(data);
    } else if (path === '/callLogger/match') {
      _matchCallLogs(data);
    } else if (path === '/contacts/search') {
      _searchContacts(data);
    } else if (path === '/contacts/match') {
      _matchContacts(data);
    }
  }

  // ─── 6. CALL LOGGING ─────────────────────────────────────────────────────────
  // Fires when: user clicks "Log to SurgiShop CRM" button,
  //             OR auto-log is enabled and call starts/ends.

  function _logCall(data) {
    var call = data.body && data.body.call;
    if (!call) {
      _respondToWidget(data.requestId, { data: 'error: no call data' });
      return;
    }

    frappe.call({
      method: 'surgishop_crm.api.ringcentral.log_call',
      args: {
        session_id:    call.sessionId || call.id || '',
        from_number:   (call.from && call.from.phoneNumber) || '',
        from_name:     (call.from && call.from.name)        || '',
        to_number:     (call.to   && call.to.phoneNumber)   || '',
        to_name:       (call.to   && call.to.name)          || '',
        direction:     call.direction   || 'Outbound',
        duration:      call.duration    || 0,
        call_status:   call.result      || call.telephonyStatus || '',
        start_time:    call.startTime   || '',
        recording_id:  (call.recording  && call.recording.id)   || '',
        recording_url: (call.recording  && call.recording.link) || '',
      },
      callback: function (r) {
        if (r.message) {
          _respondToWidget(data.requestId, { data: 'ok' });
          frappe.show_alert({
            message: '📞 Call logged: ' + r.message,
            indicator: 'green'
          }, 4);
        } else {
          _respondToWidget(data.requestId, { data: 'error' });
        }
      },
      error: function () {
        _respondToWidget(data.requestId, { data: 'error' });
      }
    });
  }

  // ─── 7. CALL LOG ENTITY MATCH ────────────────────────────────────────────────
  // Widget asks: "have these session IDs already been logged?"
  // We return a map of sessionId → [{id, note}] for any already logged.

  function _matchCallLogs(data) {
    var sessionIds = (data.body && data.body.sessionIds) || [];
    if (!sessionIds.length) {
      _respondToWidget(data.requestId, { data: {} });
      return;
    }

    frappe.call({
      method: 'surgishop_crm.api.ringcentral.match_call_logs',
      args: { session_ids: sessionIds },
      callback: function (r) {
        _respondToWidget(data.requestId, { data: r.message || {} });
      },
      error: function () {
        _respondToWidget(data.requestId, { data: {} });
      }
    });
  }

  // ─── 8. CONTACT SEARCH (widget address book) ─────────────────────────────────
  // Widget calls this when user types in the dialer search box.

  function _searchContacts(data) {
    var searchString = (data.body && data.body.searchString) || '';
    if (!searchString) {
      _respondToWidget(data.requestId, { data: [] });
      return;
    }

    frappe.call({
      method: 'surgishop_crm.api.ringcentral.search_contacts',
      args: { query: searchString },
      callback: function (r) {
        _respondToWidget(data.requestId, { data: r.message || [] });
      },
      error: function () {
        _respondToWidget(data.requestId, { data: [] });
      }
    });
  }

  // ─── 9. CONTACT MATCH (caller ID resolution) ─────────────────────────────────
  // Widget sends phone numbers; we return matching Frappe contacts.

  function _matchContacts(data) {
    var phoneNumbers = (data.body && data.body.phoneNumbers) || [];
    if (!phoneNumbers.length) {
      _respondToWidget(data.requestId, { data: {} });
      return;
    }

    frappe.call({
      method: 'surgishop_crm.api.ringcentral.match_contacts',
      args: { phone_numbers: phoneNumbers },
      callback: function (r) {
        _respondToWidget(data.requestId, { data: r.message || {} });
      },
      error: function () {
        _respondToWidget(data.requestId, { data: {} });
      }
    });
  }

  // ─── 10. SCREEN POP ──────────────────────────────────────────────────────────
  // On inbound ringing call, look up the caller and show an alert with a link.

  function _handleScreenPop(call) {
    var fromNumber = call.from && call.from.phoneNumber;
    if (!fromNumber) return;

    frappe.call({
      method: 'surgishop_crm.api.ringcentral.find_record_by_phone',
      args: { phone_number: fromNumber },
      callback: function (r) {
        var result = r.message;
        if (result && result.name) {
          var url  = result.url;
          var name = result.display_name || fromNumber;
          frappe.show_alert({
            message: '📞 Incoming call from <b>' + name + '</b>'
              + ' &nbsp;<a href="' + url + '" style="text-decoration:underline">Open Record →</a>',
            indicator: 'blue'
          }, 12);
        } else {
          frappe.show_alert({
            message: '📞 Incoming call from unknown number: ' + fromNumber,
            indicator: 'orange'
          }, 8);
        }
      }
    });
  }

  // ─── 11. MANUAL DIAL BUTTONS ON CRM PAGES ────────────────────────────────────
  // Injects a 📞 button next to phone number fields on Lead/Contact/Customer.
  // Runs after each Frappe page navigation.

  frappe.router.on('change', function () {
    setTimeout(_injectDialButtons, 1200);
  });

  // Also run on first load
  $(document).ready(function () {
    setTimeout(_injectDialButtons, 2000);
  });

  function _injectDialButtons() {
    // Selectors covering ERPNext desk forms and Frappe CRM Vue pages
    var phoneSelectors = [
      '[data-fieldname="mobile_no"]',
      '[data-fieldname="phone"]',
      '[data-fieldname="phone_no"]',
      '[data-fieldname="contact_mobile"]',
    ];

    phoneSelectors.forEach(function (selector) {
      document.querySelectorAll(selector).forEach(function (fieldEl) {
        if (fieldEl.querySelector('.rc-dial-btn')) return; // already injected

        // Find the value — could be in a read-only span or an input
        var valueEl = fieldEl.querySelector('.like-disabled-input, .control-value, input');
        if (!valueEl) return;

        var number = (valueEl.value || valueEl.textContent || '').trim();
        if (!number || number.length < 7) return;

        var btn = document.createElement('button');
        btn.className  = 'rc-dial-btn btn btn-xs btn-default';
        btn.innerHTML  = '📞';
        btn.title      = 'Call ' + number + ' via RingCentral';
        btn.setAttribute('data-number', number);

        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var num = this.getAttribute('data-number');
          if (window.RCAdapter) {
            RCAdapter.clickToCall(num, true);
          } else {
            frappe.show_alert({
              message: 'RingCentral widget is still loading. Please try again.',
              indicator: 'orange'
            }, 3);
          }
        });

        // Insert after the value element
        var parent = valueEl.parentNode;
        parent.style.display = 'flex';
        parent.style.alignItems = 'center';
        parent.style.gap = '6px';
        parent.appendChild(btn);
      });
    });
  }

  // ─── HELPER: respond back to widget ─────────────────────────────────────────

  function _respondToWidget(requestId, responseData) {
    var frame = document.querySelector('#rc-widget-adapter-frame');
    if (!frame) return;
    frame.contentWindow.postMessage({
      type:       'rc-post-message-response',
      responseId: requestId,
      response:   responseData,
    }, '*');
  }

})();
