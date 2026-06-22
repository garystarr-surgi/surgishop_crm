/**
 * Frappe CRM Client Script — CRM Lead
 *
 * Paste this into: CRM → Settings → Client Scripts → New
 *   DocType: CRM Lead
 *   Script Type: Client
 *
 * Uses Frappe CRM's class-based scripting (Vue-compatible, v0.46+).
 * Adds a 📞 dial button next to mobile_no and phone fields on Lead pages.
 *
 * The rc_widget.js global already handles C2D scanning, but this script
 * provides an explicit button for CRM Vue pages where C2D may miss fields
 * that render inside Vue components.
 */

class CRMLead {

  // Called when the Lead form is first loaded
  onLoad(doc) {
    this.doc = doc;
  }

  // Called after each save/refresh — re-inject buttons
  onRefresh(doc) {
    this.doc = doc;
    this._addDialButtons();
  }

  _addDialButtons() {
    const self = this;
    // Vue renders asynchronously — wait for DOM settle
    setTimeout(() => {
      self._injectButtonForField('mobile_no');
      self._injectButtonForField('phone');
    }, 600);
  }

  _injectButtonForField(fieldname) {
    const fieldEls = document.querySelectorAll(
      `[data-fieldname="${fieldname}"]`
    );

    fieldEls.forEach(fieldEl => {
      if (fieldEl.querySelector('.rc-crm-dial-btn')) return;

      const valueEl = fieldEl.querySelector(
        'input, .field-value, .control-value, [class*="value"]'
      );
      if (!valueEl) return;

      const number = (valueEl.value || valueEl.textContent || '').trim();
      if (!number || number.length < 7) return;

      const btn = document.createElement('button');
      btn.className = 'rc-crm-dial-btn';
      btn.innerHTML = '📞';
      btn.title     = `Call ${number} via RingCentral`;
      btn.dataset.number = number;
      btn.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'width:24px',
        'height:20px',
        'margin-left:6px',
        'padding:0',
        'font-size:12px',
        'cursor:pointer',
        'border:1px solid #d1d8dd',
        'border-radius:4px',
        'background:#f8f9fa',
        'vertical-align:middle',
        'flex-shrink:0',
      ].join(';');

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const num = btn.dataset.number;
        if (window.RCAdapter) {
          RCAdapter.clickToCall(num, true);
        } else {
          frappe.show_alert({
            message: 'RingCentral widget is loading, please try again shortly.',
            indicator: 'orange'
          }, 3);
        }
      });

      // Wrap the value element and button in a flex container
      const wrapper = document.createElement('span');
      wrapper.style.cssText = 'display:inline-flex;align-items:center;';
      valueEl.parentNode.insertBefore(wrapper, valueEl);
      wrapper.appendChild(valueEl);
      wrapper.appendChild(btn);
    });
  }
}

// Frappe CRM uses this export pattern for class-based client scripts
window.CRMLeadScripts = CRMLead;
