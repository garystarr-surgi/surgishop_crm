app_name = "surgishop_crm"
app_title = "SurgiShop CRM"
app_publisher = "SurgiShop"
app_description = "RingCentral Embeddable integration for Frappe CRM"
app_email = "gary@surgishop.com"
app_license = "MIT"

# ── Inject RC widget JS + CSS on every Frappe/CRM page ──────────────────────
app_include_js = [
    "/assets/surgishop_crm/js/rc_widget.js",
]

app_include_css = [
    "/assets/surgishop_crm/css/rc_widget.css",
]

# ── Whitelisted Python methods callable from JS ──────────────────────────────
# (defined in surgishop_crm/api/ringcentral.py)
