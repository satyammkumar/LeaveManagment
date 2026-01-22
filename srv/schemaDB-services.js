
// srv/schemaDB-service.js
const cds = require("@sap/cds");
const bcrypt = require("bcryptjs");

module.exports = cds.service.impl(async function () {
  const { Employees, LeaveRequests, LeaveBalances, LeaveTypes, Approvals } = this.entities;

  // ---------- Utilities ----------
  function calculateDays(start, end) {
    // Inclusive day count
    const s = new Date(start);
    const e = new Date(end);
    // Normalize to midnight to avoid DST issues
    s.setHours(0, 0, 0, 0);
    e.setHours(0, 0, 0, 0);
    return Math.ceil((e - s) / (1000 * 60 * 60 * 24)) + 1;
  }

  // ---------- LEAVE MANAGEMENT HOOKS ----------
  this.before("CREATE", LeaveRequests, async (req) => {
    const { employee_employeeId, leaveType_code, startDate, endDate } = req.data;

    // ✅ Allow single-day leave (start === end)
    if (new Date(startDate) > new Date(endDate)) {
      req.reject(400, "Start date cannot be after end date.");
    }

    // Check leave balance for the (employee, leaveType)
    const balanceRow = await SELECT.one
      .from(LeaveBalances)
      .where({ employee_employeeId, leaveType_code });

    const daysRequested = calculateDays(startDate, endDate);
    const available = balanceRow
      ? Number(balanceRow.accruedDays || 0) - Number(balanceRow.usedDays || 0)
      : 0;

    if (available < daysRequested) {
      req.reject(400, "Insufficient leave balance.");
    }

    // ✅ Prevent overlapping with non-cancelled & non-rejected requests
    const overlaps = await SELECT.from(LeaveRequests).where({
      employee_employeeId,
      startDate: { "<=": endDate },
      endDate: { ">=": startDate },
      status: { "not in": ["Rejected", "Cancelled"] }
    });

    if (overlaps.length > 0) {
      req.reject(400, "Overlapping leave request exists.");
    }

    // Fill server-side managed values
    req.data.daysRequested = daysRequested;
    req.data.submittedAt = new Date();
    // status default can be in CDS, but make sure if client omitted it
    if (!req.data.status) req.data.status = "Pending";
  });

  // Only relevant if requests are sometimes created as Approved initially
  this.after("CREATE", LeaveRequests, async (data, req) => {
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

  /** Submit Leave Request (custom action) */
  this.on("submitLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { employeeId, leaveTypeCode, startDate, endDate, reason } = req.data;

    // Basic referential checks
    const employee = await tx.run(SELECT.one.from(Employees).where({ employeeId }));
    const leaveType = await tx.run(SELECT.one.from(LeaveTypes).where({ code: leaveTypeCode }));
    if (!employee || !leaveType) {
      req.reject(400, "Invalid employee or leave type.");
    }

    // Let the before('CREATE') hook do the heavy lifting (balance, overlaps, days)
    const insertResult = await tx.run(
      INSERT.into(LeaveRequests).entries({
        employee_employeeId: employeeId,
        leaveType_code: leaveTypeCode,
        startDate,
        endDate,
        reason,
        status: "Pending",
      })
    );

    // Return full created entity
    const created = await tx.run(
      SELECT.one.from(LeaveRequests).where({ ID: insertResult.ID || insertResult.ID_cuid || insertResult.ID_uuid })
    );

    return created;
  });

  /** Approve Leave Request (custom action) */
  this.on("approveLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, approverId, comments } = req.data;

    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
    if (!request || request.status !== "Pending") {
      req.reject(400, "Invalid or non-pending request.");
    }

    await tx.run(
      UPDATE(LeaveRequests)
        .set({
          status: "Approved",
          approvedAt: new Date(),
          approvedBy: approverId,
        })
        .where({ ID: requestId })
    );

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: requestId,
        approverId,
        status: "Approved",
        comments,
        approvedAt: new Date(), // if your model has a generic 'decidedAt', prefer that
      })
    );

    // Increase used days only once (now that it's approved)
    await tx.run(
      UPDATE(LeaveBalances)
        .set({ usedDays: { "+=": request.daysRequested } })
        .where({
          employee_employeeId: request.employee_employeeId,
          leaveType_code: request.leaveType_code,
        })
    );

    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
  });

  /** Reject Leave Request (custom action) */
  this.on("rejectLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, approverId, comments } = req.data;

    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
    if (!request || request.status !== "Pending") {
      req.reject(400, "Invalid or non-pending request.");
    }

    await tx.run(
      UPDATE(LeaveRequests)
        .set({ status: "Rejected" })
        .where({ ID: requestId })
    );

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: requestId,
        approverId,
        status: "Rejected",
        comments,
        approvedAt: new Date(), // if your model has 'decidedAt', prefer that
      })
    );

    // No balance changes on reject
    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
  });

  /** (Optional) Cancel Leave Request (custom action) */
  this.on("cancelLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, cancellerId, comments } = req.data;

    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
    if (!request) req.reject(404, "Request not found.");

    // Only Pending or Approved can be cancelled (business rule; adjust as needed)
    if (!["Pending", "Approved"].includes(request.status)) {
      req.reject(400, "Only pending or approved requests can be cancelled.");
    }

    await tx.run(
      UPDATE(LeaveRequests).set({ status: "Cancelled" }).where({ ID: requestId })
    );

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: requestId,
        approverId: cancellerId || null,
        status: "Cancelled",
        comments: comments || null,
        approvedAt: new Date()
      })
    );

    // If it was approved, roll back usedDays
    if (request.status === "Approved") {
      await tx.run(
        UPDATE(LeaveBalances)
          .set({ usedDays: { "-=": request.daysRequested } })
          .where({
            employee_employeeId: request.employee_employeeId,
            leaveType_code: request.leaveType_code,
          })
      );
    }

    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
  });

  // ---------- COMPUTED FIELDS ----------
  // Make sure it works for both arrays and single records
  this.after("READ", LeaveBalances, (rows) => {
    const arr = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    for (const each of arr) {
      const accrued = Number(each.accruedDays || 0);
      const used = Number(each.usedDays || 0);
      each.balance = accrued - used;
    }
  });

  // ==================== LOGIN ACTION ====================
  this.on("login", async (req) => {
    const tx = cds.transaction(req);
    const { email, password } = req.data;

    if (!email || !password) {
      return { success: false, message: "Email and password are required", employee: null };
    }

    try {
      const emp = await tx.run(SELECT.one.from(Employees).where({ email }));
      if (!emp) {
        return { success: false, message: "Invalid email or password", employee: null };
      }

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
          lastName: emp.lastName || "",
          email: emp.email || "",
          department: emp.department || "",
          designation
        }
      };
    } catch (error) {
      console.error("Login error:", error);
      return { success: false, message: "An error occurred during login. Please try again.", employee: null };
    }
  });

  // ==================== REGISTRATION ACTION ====================
  this.on("register", async (req) => {
    const tx = cds.transaction(req);
    console.log("[register] 📋 Received registration request");

    if (!req.data) {
      console.log("[register] ❌ No request data provided");
      return { success: false, message: "No registration data provided" };
    }

    let { firstName = "", lastName = "", email = "", password = "", managerId = "" } = req.data;

    firstName = String(firstName || "").trim();
    lastName = String(lastName || "").trim();
    email = String(email || "").trim().toLowerCase();
    password = String(password || "");
    managerId = String(managerId || "").trim();

    if (!firstName || !lastName || !email || !password) {
      return { success: false, message: "Missing required fields (firstName, lastName, email, password)" };
    }
    if (password.length < 6) {
      return { success: false, message: "Password must be at least 6 characters" };
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      return { success: false, message: "Invalid email address" };
    }
    if (managerId && managerId.length > 10) {
      return { success: false, message: "Manager ID must be at most 10 characters" };
    }

    try {
      let existingEmp = null;
      try {
        existingEmp = await tx.run(SELECT.one.from(Employees).where({ email }));
      } catch (checkErr) {
        console.log("[register] ⚠️ Email check query failed:", checkErr.message);
      }

      if (existingEmp) {
        return { success: false, message: "User with this email already exists" };
      }

      // Hash password
      let hashedPassword = "";
      try {
        const saltRounds = 10;
        hashedPassword = await bcrypt.hash(password, saltRounds);
      } catch (hashErr) {
        console.error("[register] ❌ Password hash failed:", hashErr.message);
        return { success: false, message: "Failed to process password" };
      }

      // Generate next employee ID like E1001, E1002, ...
      let employeeId = "E1001";
      try {
        const lastEmployee = await tx.run(
          SELECT.one.from(Employees).columns("employeeId").orderBy({ employeeId: "desc" })
        );
        if (lastEmployee && lastEmployee.employeeId) {
          const currentId = lastEmployee.employeeId;
          const numPart = parseInt(currentId.replace(/[^0-9]/g, ""), 10);
          if (!isNaN(numPart)) {
            employeeId = "E" + String(numPart + 1).padStart(4, "0");
          }
        }
      } catch (idErr) {
        console.log("[register] ⚠️ ID generation error:", idErr.message);
        employeeId = "E1001";
      }

      const newEmployeeData = {
        employeeId,
        firstName,
        lastName,
        email,
        department: "General",
        managerId: managerId || null,
        password: hashedPassword
      };

      try {
        await tx.run(INSERT.into(Employees).entries(newEmployeeData));
      } catch (insertErr) {
        console.error("[register] ❌ Insert failed:", insertErr.message);
        return { success: false, message: "Failed to create employee: " + insertErr.message };
      }

      const employee = await tx.run(
        SELECT.one.from(Employees)
          .columns("employeeId", "firstName", "lastName", "email", "department", "managerId")
          .where({ employeeId })
      );

      if (!employee) {
        return { success: false, message: "Failed to verify employee creation" };
      }

      return {
        success: true,
        message: "Register Success",
        employeeId,
        employee: {
          employeeID: String(employee.employeeId),
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          department: employee.department,
          managerId: employee.managerId || null
        }
      };
    } catch (e) {
      console.error("========================================");
      console.error("❌ UNEXPECTED REGISTRATION ERROR");
      console.error("========================================");
      console.error("Error Name:", e.name);
      console.error("Error Message:", e.message);
      console.error("Error Stack:", e.stack);
      console.error("========================================");

      return { success: false, message: e.message || "Registration failed. Please try again." };
    }
  });

  // ---------- GET EMPLOYEE DATA ----------
  this.on("getEmployeeData", async (req) => {
    const tx = cds.transaction(req);
    const { email } = req.data;

    if (!email) {
      return { success: false, message: "Email is required" };
    }

    try {
      const employee = await tx.run(SELECT.one.from(Employees).where({ email }));
      if (!employee) {
        return { success: false, message: "Employee not found" };
      }

      const balances = await tx.run(
        SELECT.from(LeaveBalances)
          .columns("ID", "accruedDays", "usedDays", "leaveType_code", "employee_employeeId")
          .where({ employee_employeeId: employee.employeeId })
      );

      const leaveBalances = (balances || []).map((b) => ({
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
          id: String(employee.employeeId),
          employeeID: String(employee.employeeId),
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          department: employee.department,
          managerID: employee.managerId || ""
        },
        leaveBalances
      };
    } catch (error) {
      console.error("getEmployeeData error:", error);
      return { success: false, message: "An error occurred retrieving employee data" };
    }
  });
});
