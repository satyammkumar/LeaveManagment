
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

    onInit: function () {
      const oUsername = this.byId("username");
      const oPassword = this.byId("password");

      // Enter in Username → focus Password
      if (oUsername) {
        oUsername.addEventDelegate({
          onsapenter: function () {
            oPassword && oPassword.focus();
          }
        });
      }

      // Enter in Password → trigger onLogin
      if (oPassword) {
        oPassword.addEventDelegate({
          onsapenter: function () {
            this.onLogin();
          }.bind(this)
        });
      }

      // Reset the form whenever router targets the Login route
      const oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("Login").attachPatternMatched(this._onLoginRouteMatched, this);

      // Also reset whenever the login page is about to be shown
      this.getView().addEventDelegate({
        onBeforeShow: function () {
          this._resetLoginForm();
        }.bind(this)
      });
    },

    _resetLoginForm: function () {
      const oUsername = this.byId("username");
      const oPassword = this.byId("password");
      const oMsgStrip = this.byId("msg");

      if (oUsername) oUsername.setValue("");
      if (oPassword) oPassword.setValue("");
      if (oMsgStrip) oMsgStrip.setVisible(false);
    },

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
      const email = (this.byId("username").getValue() || "").trim();
      const password = (this.byId("password").getValue() || "").trim();

      // Basic validation
      if (!email || !password) {
        this._showError("Please enter email and password.");
        return;
      }

      // Simple email pattern check
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(email)) {
        this._showError("Please enter a valid email address.");
        return;
      }

      // Hide previous error strip if visible
      const msgStrip = this.byId("msg");
      if (msgStrip) msgStrip.setVisible(false);

      try {
        // Call CAP login (unbound action) — keep your endpoint
        const res = await fetch("/odata/v4/my-services/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password })
        });

        if (!res.ok) {
          const resClone = res.clone();
          let errTxt = "Invalid credentials";
          try {
            const ejson = await res.json();
            errTxt = ejson?.error?.message || ejson?.message || errTxt;
          } catch (e) {
            try { errTxt = (await resClone.text()) || errTxt; } catch (ee) {}
          }
          throw new Error(errTxt);
        }

        // SUCCESS: read body exactly once
        const user = await res.json();
        const emp = user?.employee;
        const router = this.getOwnerComponent().getRouter();

        // Persist to auth model (defined in manifest.json)
        const authModel = this.getOwnerComponent().getModel("auth");
        if (authModel) {
          authModel.setData({ user, isAuthenticated: true, error: "" });
        }

        // optional: remember email locally
        try { localStorage.setItem("login_email", email); } catch (e) {}

        if (!emp) {
          MessageToast.show("Invalid user");
          return;
        }

        MessageToast.show(`Welcome, ${emp?.firstName || emp?.email}`);

       
        const isAdminEmail = (emp?.email || "").toLowerCase() === "admin@gmail.com";
        const backendRole = (user?.role || user?.employee?.role || "").toLowerCase();
        const isManagerRole = backendRole === "manager";

        if (isAdminEmail || isManagerRole) {
          router.navTo("Manager");
        } else {
          const usernameParam = emp?.email;
          if (usernameParam) {
            router.navTo("Employee", { username: usernameParam });
          } else {
            router.navTo("Employee");
          }
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
      this.getOwnerComponent().getRouter().navTo("Register");
    },

    onCancelRegister: function () {
      const oDialog = this.byId("registerDialog");
      oDialog && oDialog.close();
    },

    onSubmitRegister: async function () {
      const m = this.getOwnerComponent().getModel("auth");
      const data = m.getProperty("/register") || {};
      const { firstName, lastName, email, password, confirm /*, role*/ } = data;

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
        MessageToast.show("Registration successful! Please log in.");
        this.onCancelRegister();
      } catch (e) {
        console.error("Registration error:", e);
        MessageBox.error(e.message || "Failed to register.");
      }
    }

  });
});
