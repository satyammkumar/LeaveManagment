
// srv/schemaDB-service.js
const cds = require("@sap/cds");
const bcrypt = require("bcryptjs");

module.exports = cds.service.impl(async function () {
  const { Employees, LeaveRequests, LeaveBalances, LeaveTypes, Approvals } = this.entities;

  // ---------- Utilities ----------
  function toMidnight(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function isWeekend(d) {
    const day = d.getDay(); // 0=Sun, 6=Sat
    return day === 0 || day === 6;
  }
  function businessDaysInclusive(start, end) {
    // Count only Mon–Fri inclusive
    const s = toMidnight(start);
    const e = toMidnight(end);
    if (e < s) return 0;

    let count = 0;
    const cur = new Date(s);
    while (cur <= e) {
      if (!isWeekend(cur)) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }

  async function getAvailableBalance(tx, employee_employeeId, leaveType_code) {
    const row = await tx.run(
      SELECT.one.from(LeaveBalances).where({ employee_employeeId, leaveType_code })
    );
    const accrued = Number(row?.accruedDays || 0);
    const used    = Number(row?.usedDays || 0);
    return accrued - used;
  }

  async function hasOverlap(tx, employee_employeeId, startDate, endDate) {
    const overlaps = await tx.run(
      SELECT.from(LeaveRequests).where({
        employee_employeeId,
        startDate: { "<=": endDate },
        endDate:   { ">=": startDate },
        status:    { "not in": ["Rejected", "Cancelled"] }
      })
    );
    return overlaps.length > 0;
  }

  // ---------- Hooks on LeaveRequests ----------
  this.before("CREATE", LeaveRequests, async (req) => {
    const tx = cds.transaction(req);
    const { employee_employeeId, leaveType_code, startDate, endDate } = req.data;

    if (!employee_employeeId || !leaveType_code || !startDate || !endDate) {
      req.reject(400, "Missing required fields (employee, leave type, startDate, endDate).");
    }
    if (new Date(startDate) > new Date(endDate)) {
      req.reject(400, "Start date cannot be after end date.");
    }

    const daysRequested = businessDaysInclusive(startDate, endDate);
    if (daysRequested < 1) {
      req.reject(400, "The selected range contains no business days (Mon–Fri).");
    }

    const leaveType = await tx.run(SELECT.one.from(LeaveTypes).where({ code: leaveType_code }));
    if (!leaveType) {
      req.reject(400, "Invalid leave type.");
    }
    if (leaveType.maxDays && Number(leaveType.maxDays) > 0 && daysRequested > Number(leaveType.maxDays)) {
      req.reject(400, `Requested days (${daysRequested}) exceed maxDays (${leaveType.maxDays}).`);
    }

    const available = await getAvailableBalance(tx, employee_employeeId, leaveType_code);
    if (available < daysRequested) {
      req.reject(400, `Insufficient leave balance. Available: ${available}, requested: ${daysRequested}.`);
    }

    if (await hasOverlap(tx, employee_employeeId, startDate, endDate)) {
      req.reject(400, "Overlapping leave request exists.");
    }

    req.data.daysRequested = daysRequested;
    req.data.submittedAt = new Date();
    if (!req.data.status) req.data.status = "Pending";
  });

  this.after("CREATE", LeaveRequests, async (data /*, req */) => {
    if (!data) return;
    if (data.status === "Approved") {
      await UPDATE(LeaveBalances)
        .set({ usedDays: { "+=": data.daysRequested } })
        .where({
          employee_employeeId: data.employee_employeeId,
          leaveType_code: data.leaveType_code,
        });
    }
  });

  // -------------------- Actions --------------------
  /** Submit Leave Request */
  this.on("submitLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { employeeId, leaveTypeCode, startDate, endDate, reason } = req.data;

    const employee = await tx.run(SELECT.one.from(Employees).where({ employeeId }));
    if (!employee) req.reject(400, "Invalid employee.");

    const leaveType = await tx.run(SELECT.one.from(LeaveTypes).where({ code: leaveTypeCode }));
    if (!leaveType) req.reject(400, "Invalid leave type.");

    const entry = {
      employee_employeeId: employeeId,
      leaveType_code:      leaveTypeCode,
      startDate, endDate,
      reason: (reason || "").trim(),
      status: "Pending"
    };

    let created;
    try {
      const res = await tx.run(INSERT.into(LeaveRequests).entries(entry).returning("*"));
      created = Array.isArray(res) ? res[0] : res;
    } catch (e) {
      const ins = await tx.run(INSERT.into(LeaveRequests).entries(entry));
      const createdId = ins?.ID || ins?.ID_cuid || ins?.ID_uuid;
      created = createdId
        ? await tx.run(SELECT.one.from(LeaveRequests).where({ ID: createdId }))
        : await tx.run(
            SELECT.one.from(LeaveRequests)
              .where({ employee_employeeId: employeeId, leaveType_code: leaveTypeCode, startDate, endDate })
              .orderBy({ submittedAt: "desc" })
          );
    }
    return created;
  });

  /** Approve Leave Request */
  this.on("approveLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, approverId, comments } = req.data;

    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
    if (!request || request.status !== "Pending") {
      req.reject(400, "Invalid or non-pending request.");
    }

    await tx.run(
      UPDATE(LeaveRequests)
        .set({ status: "Approved", approvedAt: new Date(), approvedBy: approverId })
        .where({ ID: requestId })
    );

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: requestId,
        approverId,
        status: "Approved",
        comments,
        approvedAt: new Date()
      })
    );

    await tx.run(
      UPDATE(LeaveBalances)
        .set({ usedDays: { "+=": request.daysRequested } })
        .where({ employee_employeeId: request.employee_employeeId, leaveType_code: request.leaveType_code })
    );

    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
  });

  /** Reject Leave Request */
  this.on("rejectLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, approverId, comments } = req.data;

    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
    if (!request || request.status !== "Pending") {
      req.reject(400, "Invalid or non-pending request.");
    }

    await tx.run(UPDATE(LeaveRequests).set({ status: "Rejected" }).where({ ID: requestId }));

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: requestId,
        approverId,
        status: "Rejected",
        comments,
        approvedAt: new Date()
      })
    );

    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
  });

  /** (Optional) Cancel Leave Request */
  this.on("cancelLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, cancellerId, comments } = req.data;

    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
    if (!request) req.reject(404, "Request not found.");
    if (!["Pending", "Approved"].includes(request.status)) {
      req.reject(400, "Only pending or approved requests can be cancelled.");
    }

    await tx.run(UPDATE(LeaveRequests).set({ status: "Cancelled" }).where({ ID: requestId }));

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: requestId,
        approverId: cancellerId || null,
        status: "Cancelled",
        comments: comments || null,
        approvedAt: new Date()
      })
    );

    if (request.status === "Approved") {
      await tx.run(
        UPDATE(LeaveBalances)
          .set({ usedDays: { "-=": request.daysRequested } })
          .where({ employee_employeeId: request.employee_employeeId, leaveType_code: request.leaveType_code })
      );
    }

    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
  });

  // ---------- COMPUTED FIELDS ----------
  this.after("READ", LeaveBalances, (rows) => {
    const arr = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    for (const each of arr) {
      const accrued = Number(each.accruedDays || 0);
      const used    = Number(each.usedDays || 0);
      each.balance  = accrued - used;
    }
  });

  // ==================== LOGIN ====================
  this.on("login", async (req) => {
    const tx = cds.transaction(req);
    const { email, password } = req.data;

    if (!email || !password) {
      return { success: false, message: "Email and password are required", employee: null };
    }

    try {
      const emp = await tx.run(SELECT.one.from(Employees).where({ email }));
      if (!emp) return { success: false, message: "Invalid email or password", employee: null };

      const isPasswordValid = await bcrypt.compare(password, emp.password);
      if (!isPasswordValid) {
        return { success: false, message: "Invalid email or password", employee: null };
      }

      const designation = emp.designation || "Employee";
      return {
        success: true,
        message: "Login successful",
        employee: {
          employeeID: String(emp.employeeId),
          firstName: emp.firstName || "",
          lastName:  emp.lastName  || "",
          email:     emp.email     || "",
          department: emp.department || "",
          designation
        }
      };
    } catch (error) {
      console.error("Login error:", error);
      return { success: false, message: "An error occurred during login. Please try again.", employee: null };
    }
  });

  // ==================== REGISTER (as you had) ====================
  this.on("register", async (req) => {
    // (your existing implementation here – unchanged)
    // Keep or adapt as you already wrote; it is independent of the FK changes above.
    // ...
  });

  // ---------- GET EMPLOYEE DATA ----------
  this.on("getEmployeeData", async (req) => {
    const tx = cds.transaction(req);
    const { email } = req.data;
    if (!email) return { success: false, message: "Email is required" };

    try {
      const employee = await tx.run(SELECT.one.from(Employees).where({ email }));
      if (!employee) return { success: false, message: "Employee not found" };

      const balances = await tx.run(
        SELECT.from(LeaveBalances)
          .columns("ID", "accruedDays", "usedDays", "leaveType_code", "employee_employeeId")
          .where({ employee_employeeId: employee.employeeId })
      );

      const leaveBalances = (balances || []).map(b => ({
        id: String(b.ID),
        accruedDays: Number(b.accruedDays || 0),
        usedDays: Number(b.usedDays || 0),
        balance: Number(b.accruedDays || 0) - Number(b.usedDays || 0),
        leaveTypeCode: b.leaveType_code || ""
      }));

      return {
        success: true,
        message: "Employee data retrieved successfully",
        employee: {
          id:         String(employee.employeeId),
          employeeID: String(employee.employeeId),
          firstName:  employee.firstName,
          lastName:   employee.lastName,
          email:      employee.email,
          department: employee.department,
          managerID:  employee.managerId || ""
        },
        leaveBalances
      };
    } catch (error) {
      console.error("getEmployeeData error:", error);
      return { success: false, message: "An error occurred retrieving employee data" };
    }
  });
});
