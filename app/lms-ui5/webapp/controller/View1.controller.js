sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, MessageBox, MessageToast) {
  "use strict";

  return Controller.extend("lmsui5.controller.View1", {

    onRegister: function () {
      this.getOwnerComponent().getRouter().navTo("Register");
    },

    // ✅ ADDITIONS: Enter behavior + reset on return to Login
    onInit: function () {
      const oUsername = this.byId("username");
      const oPassword = this.byId("password");
      const oLoginBtn = this.byId("btnLogin");

      // Enter in Username → focus Password
      if (oUsername) {
        oUsername.addEventDelegate({
          onsapenter: function () {
            oPassword && oPassword.focus();
          }
        });
      }

      // Enter in Password → trigger existing onLogin
      if (oPassword) {
        oPassword.addEventDelegate({
          onsapenter: function () {
            this.onLogin();  // uses your existing onLogin logic
          }.bind(this)
        });
      }

      // Optional: Space/Enter on Login button → press -> onLogin
      if (oLoginBtn) {
        oLoginBtn.attachPress(this.onLogin, this);
      }

      // 🔹 Reset the form whenever router targets the Login route
      const oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("Login").attachPatternMatched(this._onLoginRouteMatched, this);

      // 🔹 Also reset whenever the login page is about to be shown
      this.getView().addEventDelegate({
        onBeforeShow: function () {
          this._resetLoginForm();
        }.bind(this)
      });
    },

    // 🔧 Helper to clear inputs and hide error strip
    _resetLoginForm: function () {
      const oUsername = this.byId("username");
      const oPassword = this.byId("password");
      const oMsgStrip = this.byId("msg");

      if (oUsername) oUsername.setValue("");
      if (oPassword) oPassword.setValue("");
      if (oMsgStrip) oMsgStrip.setVisible(false);

      // Optional: if you want to always start empty, also clear remembered email:
      // try { localStorage.removeItem("login_email"); } catch (e) {}
    },

    // 🔁 Called whenever the Login route is matched (e.g., after logout or returning from Register)
    _onLoginRouteMatched: function () {
      this._resetLoginForm();

      // Optional: reset auth flags
      const authModel = this.getOwnerComponent().getModel("auth");
      if (authModel) {
        authModel.setProperty("/isAuthenticated", false);
        authModel.setProperty("/error", "");
        authModel.setProperty("/user", {});
      }
    },

    onLogin: async function () {
      const email = this.byId("username").getValue().trim();   // XML id = username
      const password = this.byId("password").getValue().trim(); // XML id = password

      // Basic validation
      if (!email || !password) {
        this._showError("Please enter email and employee ID.");
        return;
      }

      // Optional: simple email pattern check
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(email)) {
        this._showError("Please enter a valid email address.");
        return;
      }

      // Hide previous error strip if visible
      const msgStrip = this.byId("msg");
      if (msgStrip) msgStrip.setVisible(false);

      try {
        // Call CAP login (unbound action) — KEEPING YOUR ORIGINAL PATH & HEADERS
        const res = await fetch("/odata/v4/my-services/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email, employeeID: password })
        });

        if (!res.ok) {
          // IMPORTANT: clone before attempting different readers to avoid
          // "Failed to execute 'text' on 'Response': body stream already read"
          const resClone = res.clone();
          let errTxt = "Invalid credentials";
          try {
            // Try to read JSON from the original response ONCE
            const ejson = await res.json();
            errTxt = ejson?.error?.message || ejson?.message || errTxt;
          } catch (e) {
            // Fallback: read text from the CLONE (not the original)
            try {
              errTxt = (await resClone.text()) || errTxt;
            } catch (ee) {
              // keep default errTxt
            }
          }
          throw new Error(errTxt);
        }

        // SUCCESS: read body exactly once
        const user = await res.json();
        const emp = user.employee;
        console.log(user, "user");

        // Persist to auth model (defined in manifest.json)
        const authModel = this.getOwnerComponent().getModel("auth");
        if (authModel) {
          authModel.setData({ user, isAuthenticated: true, error: "" });
        }

        // optional: remember email locally
        try { localStorage.setItem("login_email", email); } catch (e) { /* ignore */ }

        if (emp) {
          MessageToast.show(`Welcome, ${emp?.firstName || emp?.email}`);
        } else {
          MessageToast.show(`Invalid user`);
        }

        // Navigate to Employee view, pass username if your route expects it
        // Ensure manifest routing has: pattern "employee/{username}"
        const usernameParam = emp?.email;
        console.log(usernameParam, "test");
        if (usernameParam) {
          this.getOwnerComponent().getRouter().navTo("Employee", { username: usernameParam });
        }
      } catch (err) {
        this._showError(err.message || "Login failed");
      }
    },

    /**
     * Helper to show error consistently in MessageStrip and MessageBox.
     */
    _showError: function (message) {
      // Update auth model error (if you bind it elsewhere)
      const authModel = this.getOwnerComponent().getModel("auth");
      if (authModel) {
        authModel.setProperty("/error", message);
        authModel.setProperty("/isAuthenticated", false);
      }

      // Show MessageStrip in the view
      const msgStrip = this.byId("msg");
      if (msgStrip) {
        msgStrip.setText(message);
        msgStrip.setType("Error");
        msgStrip.setShowIcon(true);
        msgStrip.setVisible(true);
      }

      // Pop a dialog too
      MessageBox.error(message);
    },

    onAfterRendering: function () {
      // Autofill email if remembered (remove if you want always-empty on return)
      try {
        const remembered = localStorage.getItem("login_email");
        if (remembered) this.byId("username").setValue(remembered);
      } catch (e) {
        // ignore storage errors
      }
    },

    onOpenRegister: function () {
      // Navigate to Register view instead of opening inline dialog
      this.getOwnerComponent().getRouter().navTo("Register");
    },

    onCancelRegister: function () {
      // This is no longer needed for inline dialog, but kept for reference
      // The Register controller will handle navigation back to Login
      const oDialog = this.byId("registerDialog");
      oDialog && oDialog.close();
    },

    onSubmitRegister: async function () {
      // This is no longer needed since registration is handled in Register controller
      // But keeping the logic as fallback
      const m = this.getOwnerComponent().getModel("auth");
      const data = m.getProperty("/register") || {};
      const { firstName, lastName, email, password, confirm, role } = data;

      // Basic validation
      if (!firstName || !lastName || !email || !password || !confirm) {
        MessageBox.warning("Please fill in all required fields.");
        return;
      }
      if (password !== confirm) {
        MessageBox.error("Passwords do not match.");
        return;
      }
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(email)) {
        MessageBox.error("Please enter a valid email address.");
        return;
      }

      try {
        // TODO: Replace with your CAP/OData endpoint
        // Example: OData V4
        // const oModel = this.getOwnerComponent().getModel();
        // const list = oModel.bindList("/Users");
        // await list.create({ firstName, lastName, email, role, password }).created();

        MessageToast.show("Registration successful! Please log in.");
        this.onCancelRegister();
      } catch (e) {
        console.error("Registration error:", e);
        MessageBox.error(e.message || "Failed to register.");
      }
    }

  });
});