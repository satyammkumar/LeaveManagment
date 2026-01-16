
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, JSONModel, MessageBox, MessageToast) {
  "use strict";

  return Controller.extend("lmsui5.controller.Register", {

    onInit: function () {
      // Initialize register form model with proper binding
      const oRegisterModel = new JSONModel({
        firstName: "",
        lastName: "",
        email: "",
        password: "",
        confirmPassword: "",
      });
      this.getView().setModel(oRegisterModel, "register");

      // Router hook: reset form when route is matched
      const oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("Register").attachPatternMatched(this._onRegisterRouteMatched, this);

      // (Re)attach Enter navigation after each render
      this.getView().addEventDelegate({
        onAfterRendering: this._setupEnterKeyNavigation.bind(this)
      });
    },

    /** Setup Enter key to move between fields using UI5's event delegate */
    _setupEnterKeyNavigation: function () {
      const that = this;

      // Ensure these IDs match the XML exactly
      const aFieldIds = ["firstName", "lastName", "email", "pass", "confirmPassword"];

      // Clean up previous delegates to avoid duplicates on rerender
      aFieldIds.forEach((fieldId) => {
        const oField = this.byId(fieldId);
        if (oField && oField._enterDelegate) {
          oField.removeEventDelegate(oField._enterDelegate, oField);
          oField._enterDelegate = null;
        }
      });
      const oBtnRegister = this.byId("Register");
      if (oBtnRegister && oBtnRegister._enterDelegate) {
        oBtnRegister.removeEventDelegate(oBtnRegister._enterDelegate, oBtnRegister);
        oBtnRegister._enterDelegate = null;
      }

      // Attach fresh onsapenter delegates in display order
      aFieldIds.forEach((fieldId, index) => {
        const oField = this.byId(fieldId);
        if (oField) {
          const oDelegate = {
            onsapenter: function () {
              // Move to next field, else focus Register button
              if (index < aFieldIds.length - 1) {
                const oNextField = that.byId(aFieldIds[index + 1]);
                oNextField && oNextField.focus && oNextField.focus();
              } else {
                const oBtn = that.byId("Register"); // matches XML id="Register"
                oBtn && oBtn.focus && oBtn.focus();
              }
            }
          };
          oField.addEventDelegate(oDelegate, oField);
          oField._enterDelegate = oDelegate;
        }
      });

      // Enter on Register button should trigger registration
      if (oBtnRegister) {
        const oBtnDelegate = {
          onsapenter: () => this.onRegister()
        };
        oBtnRegister.addEventDelegate(oBtnDelegate, oBtnRegister);
        oBtnRegister._enterDelegate = oBtnDelegate;
      }
    },

    /** Handle route matched to Register page: reset form & hide error */
    _onRegisterRouteMatched: function () {
      const oRegisterModel = this.getView().getModel("register");
      if (oRegisterModel) {
        oRegisterModel.setData({
          firstName: "",
          lastName: "",
          email: "",
          password: "",
          confirmPassword: "",
        });
      }

      const oMsg = this.byId("registerMsg");
      oMsg && oMsg.setVisible(false);

      // Focus the first field for convenience
      const oFirst = this.byId("firstName");
      oFirst && oFirst.focus && oFirst.focus();
    },

    /** Navigate back to Login */
    onBackToLogin: function () {
      this.getOwnerComponent().getRouter().navTo("Login");
    },

    /** Submit registration */
    onRegister: async function () {
      const oRegisterModel = this.getView().getModel("register");
      const oData = oRegisterModel.getData();
      const oMsg = this.byId("registerMsg");

      // Validation
      if (!oData.firstName?.trim()) {
        this._showError(oMsg, "Please enter first name");
        return;
      }
      if (!oData.lastName?.trim()) {
        this._showError(oMsg, "Please enter last name");
        return;
      }
      if (!oData.email?.trim()) {
        this._showError(oMsg, "Please enter email");
        return;
      }
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(oData.email)) {
        this._showError(oMsg, "Please enter a valid email address");
        return;
      }
      if (!oData.password?.trim()) {
        this._showError(oMsg, "Please enter password");
        return;
      }
      if (oData.password.length < 6) {
        this._showError(oMsg, "Password must be at least 6 characters");
        return;
      }
      if (oData.password !== oData.confirmPassword) {
        this._showError(oMsg, "Passwords do not match");
        return;
      }

      try {
        // TODO: Replace with your actual registration API call
        const res = await fetch("/odata/v4/my-services/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            firstName: oData.firstName.trim(),
            lastName: oData.lastName.trim(),
            email: oData.email.trim(),
            password: oData.password,
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error?.message || "Registration failed");
        }

        const result = await res.json();
        // You can log or use result as needed
        MessageToast.show("Registration successful! Please login.");

        setTimeout(() => {
          this.getOwnerComponent().getRouter().navTo("Login");
        }, 1500);

      } catch (err) {
        this._showError(oMsg, err.message || "Registration failed. Please try again.");
      }
    },

    /** Helper: Show error message */
    _showError: function (oMsgStrip, sText) {
      if (oMsgStrip) {
        oMsgStrip.setText(sText);
        oMsgStrip.setVisible(true);
      } else {
        MessageBox.error(sText);
      }
    }

  });
});
