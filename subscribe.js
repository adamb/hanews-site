(function () {
  var CHECK_INBOX =
    "Check your inbox and click the confirm link. We will not send the brief until you do.";
  var ALREADY = "You're already confirmed.";
  var MAIL_FAILED =
    "Could not send the confirmation email. Try again, or email adam@code.pr.";
  var GENERIC =
    "Could not record that. Try again, or email adam@code.pr.";
  var MAILTO = "mailto:adam@code.pr?subject=HA%20News%20subscribe";

  function statusEl(form) {
    var root = form.closest(".signup-modal") || form.parentNode || form;
    var el = root.querySelector(".sub-status");
    if (!el) {
      el = document.createElement("p");
      el.className = "sub-status";
      el.setAttribute("role", "status");
      form.appendChild(el);
    }
    return el;
  }

  function readFields(form) {
    var nameIn = form.querySelector('input[name="name"]');
    var emailIn = form.querySelector('input[name="email"]');
    var phoneIn = form.querySelector('input[name="phone"]');
    return {
      name: nameIn ? String(nameIn.value).trim() : "",
      email: emailIn ? String(emailIn.value).trim() : "",
      phone: phoneIn ? String(phoneIn.value).trim() : "",
    };
  }

  function mailtoFallback(data) {
    var body =
      "name: " +
      data.name +
      "\nemail: " +
      data.email +
      "\nphone: " +
      data.phone;
    window.location.href = MAILTO + "&body=" + encodeURIComponent(body);
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function onSubmit(ev) {
    var form = ev.currentTarget;
    var data = readFields(form);
    var status = statusEl(form);
    ev.preventDefault();
    if (!data.name || !data.email || !data.phone) return;
    status.textContent = "";

    fetch("/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name: data.name,
        email: data.email,
        phone: data.phone,
      }),
    })
      .then(function (res) {
        if (res.status === 404) {
          mailtoFallback(data);
          return;
        }
        return res.text().then(function (text) {
          var body = parseJson(text);
          var err = body && body.error;
          if (res.status === 502 || err === "mail_failed") {
            status.textContent = MAIL_FAILED;
            return;
          }
          if (res.ok || res.status === 202) {
            if (body && body.confirmed === true) {
              status.textContent = ALREADY;
            } else {
              status.textContent = CHECK_INBOX;
            }
            form.reset();
            return;
          }
          status.textContent = GENERIC;
        });
      })
      .catch(function () {
        mailtoFallback(data);
      });
  }

  function openSignupModal() {
    var dialog = document.querySelector("dialog.signup-modal");
    if (dialog && typeof dialog.showModal === "function") {
      dialog.showModal();
    }
  }

  document.querySelectorAll("form.sub-form").forEach(function (form) {
    form.addEventListener("submit", onSubmit);
  });

  document.querySelectorAll(".signup-trigger").forEach(function (btn) {
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      openSignupModal();
    });
  });
})();
