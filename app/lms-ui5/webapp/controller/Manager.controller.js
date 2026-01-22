
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/ui/core/BusyIndicator",
  "sap/ui/core/format/DateFormat"
], function (Controller, Filter, FilterOperator, MessageBox, MessageToast, BusyIndicator, DateFormat) {
  "use strict";

  const SERVICE_BASE = "/odata/v4/my-services"; // adjust if different

  return Controller.extend("lmsui5.controller.Manager", {

    onInit: function () {
      const vm = new sap.ui.model.json.JSONModel({
        kpi: { pending: 0, approvedToday: 0, rejectedToday: 0 }
      });
      this.getView().setModel(vm, "view");

      const sel = this.byId("selStatus");
      sel && sel.setSelectedKey("Pending");

      const tbl = this.byId("tblRequests");
      tbl.attachSelectionChange(this._onSelectionChange, this);

      this._applyAllFilters();
    },

    /* ---------- Formatters ---------- */
    _fmtDate: DateFormat.getDateInstance({ style: "medium" }),
    _fmtDT:   DateFormat.getDateTimeInstance({ style: "medium" }),
    formatDateRange: function (s, e) {
      if (!s && !e) return "";
      const S = s ? this._fmtDate.format(new Date(s)) : "";
      const E = e ? this._fmtDate.format(new Date(e)) : "";
      return S && E ? `${S} → ${E}` : (S || E);
    },
    formatDateTime: function (dt) {
      return dt ? this._fmtDT.format(new Date(dt)) : "";
    },
    formatStatusState: function (s) {
      switch ((s || "").toLowerCase()) {
        case "approved": return "Success";
        case "rejected": return "Error";
        case "pending":  return "Warning";
        case "cancelled":return "None";
        default:         return "None";
      }
    },

    /* ---------- Filters & Search ---------- */
    onStatusChange: function () { this._applyAllFilters(); },
    onDateRangeChange: function () { this._applyAllFilters(); },
    onSearch: function (e) { this._applyAllFilters(e.getParameter("query") || ""); },
    onLiveSearch: function (e) { this._applyAllFilters(e.getParameter("newValue") || ""); },

    onClearFilters: function () {
      this.byId("selStatus").setSelectedKey("Pending");
      const dr = this.byId("drSubmitted");
      dr.setDateValue(null); dr.setSecondDateValue(null);
      this.byId("reqSearch").setValue("");
      this._applyAllFilters("");
    },

    _applyAllFilters: function (sQuery) {
      const table = this.byId("tblRequests");
      const b = table && table.getBinding("items");
      if (!b) return;

      const mgrId = this._getManagerId();
      const fs = [];

      if (mgrId) {
        fs.push(new Filter("employee/managerId", FilterOperator.EQ, mgrId));
      }

      const key = this.byId("selStatus").getSelectedKey();
      if (key && key !== "All") {
        fs.push(new Filter("status", FilterOperator.EQ, key));
      }

      const dr = this.byId("drSubmitted");
      if (dr.getDateValue() && dr.getSecondDateValue()) {
        const from = new Date(dr.getDateValue());
        const to   = new Date(dr.getSecondDateValue());
        to.setHours(23,59,59,999);
        fs.push(new Filter("submittedAt", FilterOperator.GE, from.toISOString()));
        fs.push(new Filter("submittedAt", FilterOperator.LE, to.toISOString()));
      }

      const q = (sQuery || this.byId("reqSearch").getValue() || "").trim();
      if (q) {
        fs.push(new Filter({
          and: false,
          filters: [
            new Filter("employee/firstName",     FilterOperator.Contains, q),
            new Filter("employee/lastName",      FilterOperator.Contains, q),
            new Filter("employee/employeeId",    FilterOperator.Contains, q),
            new Filter("employee/email",         FilterOperator.Contains, q),
            new Filter("leaveType/code",         FilterOperator.Contains, q),
            new Filter("leaveType/description",  FilterOperator.Contains, q),
            new Filter("reason",                 FilterOperator.Contains, q)
          ]
        }));
      }

      b.filter(fs, "Application");
    },

    onRefresh: function () {
      const m = this.getView().getModel();
      if (!m) return;
      BusyIndicator.show(0);
      m.refresh(true);
      setTimeout(() => {
        BusyIndicator.hide();
        this._refreshKPIs();
        MessageToast.show("Data refreshed");
      }, 250);
    },

    onUpdateFinished: function () {
      const has = (this.byId("tblRequests").getItems() || []).length > 0;
      this.byId("msEmpty").setVisible(!has);
      this._refreshKPIs();
    },

    _onSelectionChange: function () {
      const cnt = (this.byId("tblRequests").getSelectedItems() || []).length;
      this.byId("btnApproveSel").setEnabled(cnt > 0);
      this.byId("btnRejectSel").setEnabled(cnt > 0);
    },

    /* ---------- Popover / Row ---------- */
    onRowPress: function (e) {
      const item = e.getSource();
      const ctx = item.getBindingContext();
      const pop = this.byId("popDetails");
      pop.bindElement(ctx.getPath());
      pop.openBy(item);
    },

    /* ---------- Approvals ---------- */
    onApproveSelected: function () {
      this._confirmAndRun("Approve selected requests?", "Approved", this._selectedContexts());
    },
    onRejectSelected: function () {
      this._confirmAndRun("Reject selected requests?", "Rejected", this._selectedContexts());
    },
    onApproveOne: function (e) {
      this._confirmAndRun("Approve this request?", "Approved", [e.getSource().getBindingContext()]);
    },
    onRejectOne: function (e) {
      this._confirmAndRun("Reject this request?", "Rejected", [e.getSource().getBindingContext()]);
    },
    onApproveFromPopover: function () {
      const pop = this.byId("popDetails");
      this._confirmAndRun("Approve this request?", "Approved", [pop.getBindingContext()], () => pop.close());
    },
    onRejectFromPopover: function () {
      const pop = this.byId("popDetails");
      this._confirmAndRun("Reject this request?", "Rejected", [pop.getBindingContext()], () => pop.close());
    },

    _selectedContexts: function () {
      return (this.byId("tblRequests").getSelectedItems() || []).map(i => i.getBindingContext());
    },

    _confirmAndRun: function (msg, status, ctxs, after) {
      if (!ctxs || !ctxs.length) return;
      MessageBox.confirm(msg, {
        onClose: (a) => { if (a === MessageBox.Action.OK) this._patchStatus(ctxs, status).then(() => after && after()); }
      });
    },

    async _patchStatus(ctxs, newStatus) {
      const mgrId = this._getManagerId();
      const nowIso = new Date().toISOString();
      BusyIndicator.show(0);
      try {
        const jobs = ctxs.map(async (c) => {
          const path = c.getPath(); // "/LeaveRequests(ID=guid'...')"
          const url  = SERVICE_BASE + path;
          const res = await fetch(url, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "If-Match": "*" },
            body: JSON.stringify({ status: newStatus, approvedAt: nowIso, approvedBy: mgrId })
          });
          if (!res.ok) throw new Error(await res.text());
        });
        await Promise.all(jobs);
        this.getView().getModel().refresh(true);
        MessageToast.show(`Request(s) ${newStatus.toLowerCase()}`);
      } catch (e) {
        MessageBox.error(e.message || "Failed to update one or more requests.");
      } finally {
        BusyIndicator.hide();
        this._onSelectionChange();
      }
    },

    /* ---------- KPIs ---------- */
    _refreshKPIs: function () {
      const items = this.byId("tblRequests").getItems() || [];
      const today = new Date(); const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0,0,0,0);
      const end   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23,59,59,999);
      let pending=0, approvedToday=0, rejectedToday=0;

      items.forEach((it) => {
        const o = it.getBindingContext().getObject();
        const s = (o.status || "").toLowerCase();
        if (s === "pending") pending++;
        if (o.approvedAt) {
          const t = new Date(o.approvedAt);
          if (t >= start && t <= end) {
            if (s === "approved") approvedToday++;
            if (s === "rejected") rejectedToday++;
          }
        }
      });
      this.getView().getModel("view").setProperty("/kpi", { pending, approvedToday, rejectedToday });
    },

    /* ---------- Common ---------- */
    _getManagerId: function () {
      const um = this.getOwnerComponent().getModel("user") || this.getView().getModel("user");
      return um && um.getProperty("/employeeId");
    },

    onLogout: function () {
      sap.ui.require(["sap/ui/core/routing/HashChanger", "sap/m/MessageToast"], (HashChanger, MessageToast) => {
        HashChanger.getInstance().setHash("");
        MessageToast.show("Logged out");
      });
    }
  });
});
