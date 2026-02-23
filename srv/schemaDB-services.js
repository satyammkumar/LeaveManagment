const cds = require("@sap/cds");
const bcrypt = require("bcryptjs");

module.exports = cds.service.impl(async function () {
  const { Employees, LeaveRequests, LeaveBalances, LeaveTypes, Approvals } = this.entities;

  function toMidnight(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function isWeekend(d) {
    const day = d.getDay();
    return day === 0 || day === 6;
  }

  function businessDaysInclusive(start, end) {
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
    const used = Number(row?.usedDays || 0);
    return accrued - used;
  }

  async function hasOverlap(tx, employee_employeeId, startDate, endDate) {
    const overlaps = await tx.run(
      SELECT.from(LeaveRequests).where({
        employee_employeeId,
        startDate: { "<=": endDate },
        endDate: { ">=": startDate },
        status: { "not in": ["Rejected", "Cancelled"] }
      })
    );
    return overlaps.length > 0;
  }

  async function getEmployeeName(tx, employeeId) {
    if (!employeeId) return "";
    try {
      const employee = await tx.run(
        SELECT.one.from(Employees)
          .columns("firstName", "lastName", "email")
          .where({ employeeId })
      );
      if (!employee) return employeeId;
      const fullName = [employee.firstName, employee.lastName]
        .filter(Boolean).join(' ').trim();
      return fullName || employee.email || employeeId;
    } catch (error) {
      console.error(`Error fetching employee name for ${employeeId}:`, error);
      return employeeId;
    }
  }

  // ✅ FIX: Helper to resolve requestId safely
  // The frontend sends 'id' (lowercase string from leaveRequests action)
  // but the entity key is 'ID' (UUID). This handles both cases.
  function resolveRequestId(requestId) {
    if (!requestId) return null;
    const s = String(requestId).trim();
    if (!s || s === "undefined" || s === "null") return null;
    return s;
  }

  // HOOKS ON LEAVE REQUESTS

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

    if (!req.data.empname) {
      req.data.empname = await getEmployeeName(tx, employee_employeeId);
    }
  });

  this.after("CREATE", LeaveRequests, async (data) => {
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

  this.after("READ", LeaveRequests, async (results, req) => {
    const tx = cds.transaction(req);
    const rows = Array.isArray(results) ? results : (results ? [results] : []);
    for (const row of rows) {
      if (row && row.employee_employeeId) {
        if (!row.empname || row.empname === row.employee_employeeId) {
          row.empname = await getEmployeeName(tx, row.employee_employeeId);
        }
      }
    }
  });

  this.after("READ", LeaveBalances, (rows) => {
    const arr = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    for (const each of arr) {
      const accrued = Number(each.accruedDays || 0);
      const used = Number(each.usedDays || 0);
      each.balance = accrued - used;
    }
  });

  // ACTION: submitLeaveRequest
  this.on("submitLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { employeeId, leaveTypeCode, startDate, endDate, reason } = req.data;

    const employee = await tx.run(SELECT.one.from(Employees).where({ employeeId }));
    if (!employee) req.reject(400, "Invalid employee.");

    const empName = await getEmployeeName(tx, employeeId);

    const leaveType = await tx.run(SELECT.one.from(LeaveTypes).where({ code: leaveTypeCode }));
    if (!leaveType) req.reject(400, "Invalid leave type.");

    const daysRequested = businessDaysInclusive(new Date(startDate), new Date(endDate));

    const entry = {
      employee_employeeId: employeeId,
      leaveType_code: leaveTypeCode,
      startDate,
      endDate,
      daysRequested,
      reason: (reason || "").trim(),
      status: "Pending",
      empname: empName,
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

    if (created) created.empName = empName;
    return created;
  });

  // ✅ FIX: approveLeaveRequest - robust ID resolution with detailed logging
  this.on("approveLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, approverId, comments } = req.data;

    // ✅ Log what we received so we can debug ID mismatches
    console.log("[approveLeaveRequest] received requestId:", requestId, "type:", typeof requestId);

    const resolvedId = resolveRequestId(requestId);
    if (!resolvedId) {
      console.error("[approveLeaveRequest] requestId is empty or invalid:", requestId);
      return req.reject(400, "Request ID is required.");
    }

    // ✅ Try to find the request — log the result so we know if it's found
    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: resolvedId }));
    console.log("[approveLeaveRequest] found request:", request ? `status=${request.status}` : "NOT FOUND");

    if (!request) {
      return req.reject(400, `Leave request not found for ID: ${resolvedId}`);
    }
    if (request.status !== "Pending") {
      return req.reject(400, `Request is already ${request.status}. Only Pending requests can be approved.`);
    }

    await tx.run(
      UPDATE(LeaveRequests)
        .set({
          status: "Approved",
          approvedAt: new Date(),
          approvedBy: approverId || null,
          managerComments: comments || null
        })
        .where({ ID: resolvedId })
    );

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: resolvedId,
        approverId,
        status: "Approved",
        comments,
        approvedAt: new Date()
      })
    );

    await tx.run(
      UPDATE(LeaveBalances)
        .set({ usedDays: { "+=": request.daysRequested } })
        .where({
          employee_employeeId: request.employee_employeeId,
          leaveType_code: request.leaveType_code
        })
    );

    console.log("[approveLeaveRequest] successfully approved:", resolvedId);
    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: resolvedId }));
  });

  // ✅ FIX: rejectLeaveRequest - robust ID resolution with detailed logging
  this.on("rejectLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, approverId, comments } = req.data;

    // ✅ Log what we received so we can debug ID mismatches
    console.log("[rejectLeaveRequest] received requestId:", requestId, "type:", typeof requestId);

    const resolvedId = resolveRequestId(requestId);
    if (!resolvedId) {
      console.error("[rejectLeaveRequest] requestId is empty or invalid:", requestId);
      return req.reject(400, "Request ID is required.");
    }

    // ✅ Try to find the request — log the result
    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: resolvedId }));
    console.log("[rejectLeaveRequest] found request:", request ? `status=${request.status}` : "NOT FOUND");

    if (!request) {
      return req.reject(400, `Leave request not found for ID: ${resolvedId}`);
    }
    if (request.status !== "Pending") {
      return req.reject(400, `Request is already ${request.status}. Only Pending requests can be rejected.`);
    }

    await tx.run(
      UPDATE(LeaveRequests)
        .set({
          status: "Rejected",
          approvedAt: new Date(),
          approvedBy: approverId || null,
          managerComments: comments || null
        })
        .where({ ID: resolvedId })
    );

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: resolvedId,
        approverId,
        status: "Rejected",
        comments,
        approvedAt: new Date()
      })
    );

    console.log("[rejectLeaveRequest] successfully rejected:", resolvedId);
    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: resolvedId }));
  });

  // ACTION: cancelLeaveRequest
  this.on("cancelLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, cancellerId, comments } = req.data;

    console.log("[cancelLeaveRequest] received requestId:", requestId);

    const resolvedId = resolveRequestId(requestId);
    if (!resolvedId) return req.reject(400, "Request ID is required.");

    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: resolvedId }));
    if (!request) req.reject(404, "Request not found.");
    if (!["Pending", "Approved"].includes(request.status)) {
      req.reject(400, "Only pending or approved requests can be cancelled.");
    }

    await tx.run(UPDATE(LeaveRequests).set({ status: "Cancelled" }).where({ ID: resolvedId }));

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: resolvedId,
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
          .where({
            employee_employeeId: request.employee_employeeId,
            leaveType_code: request.leaveType_code
          })
      );
    }

    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: resolvedId }));
  });

  // ACTION: login
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

  // ACTION: register
  this.on('register', async (req) => {
    const { firstName, lastName, email, password, managerId } = req.data;

    console.log('[register] Request received:', { firstName, lastName, email });

    if (!firstName || !lastName || !email || !password) {
      return req.reject(400, 'Missing required fields');
    }
    if (password.length < 6) {
      return req.reject(400, 'Password must be at least 6 characters');
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      return req.reject(400, 'Invalid email address');
    }

    const tx = cds.transaction(req);

    try {
      const existingEmp = await tx.run(SELECT.one.from(Employees).where({ email }));
      if (existingEmp) {
        return req.reject(409, 'User with this email already exists');
      }

      const lastEmployee = await tx.run(
        SELECT.one.from(Employees).orderBy({ employeeId: 'desc' })
      );

      let employeeId = 'E1001';
      if (lastEmployee && lastEmployee.employeeId) {
        const currentId = lastEmployee.employeeId;
        const numericPart = parseInt(currentId.replace(/[^0-9]/g, ''), 10);
        if (!isNaN(numericPart)) {
          employeeId = 'E' + String(numericPart + 1).padStart(currentId.length - 1, '0');
        }
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      await tx.run(
        INSERT.into(Employees).entries({
          employeeId, firstName, lastName, email,
          department: 'General',
          password: hashedPassword,
          managerId: managerId || null
        })
      );

      const employee = await tx.run(SELECT.one.from(Employees).where({ email }));
      if (!employee) return req.reject(500, 'Failed to create employee');

      try {
        const leaveTypes = await tx.run(SELECT.from(LeaveTypes));
        if (leaveTypes && leaveTypes.length > 0) {
          const balanceEntries = leaveTypes.map(lt => ({
            employee_ID: employee.ID,
            leaveType_ID: lt.ID,
            accruedDays: 0,
            usedDays: 0,
            balance: 0
          }));
          await tx.run(INSERT.into(LeaveBalances).entries(balanceEntries));
        }
      } catch (e) {
        console.warn('[register] Leave balance initialization failed:', e.message);
      }

      await tx.commit();

      return {
        success: true,
        message: 'Registered successfully. Please log in.',
        employeeId,
        employee: {
          employeeID: String(employee.employeeId),
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email
        }
      };
    } catch (e) {
      console.error('[register] Error:', e);
      await tx.rollback();
      return req.reject(500, e.message || 'Registration failed');
    }
  });

  // ACTION: getEmployeeData
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

  // ACTION: getEmployeeLeaveBalance
  this.on("getEmployeeLeaveBalance", async (req) => {
    const tx = cds.transaction(req);
    const { employeeID } = req.data;

    if (!employeeID) {
      return { success: false, message: "Employee ID is required", balances: [], count: 0 };
    }

    try {
      const balances = await tx.run(
        SELECT.from(LeaveBalances).where({ employee_employeeId: employeeID })
      );

      const leaveTypes = await tx.run(SELECT.from(LeaveTypes));
      const leaveTypeMap = {};
      (leaveTypes || []).forEach(lt => {
        leaveTypeMap[lt.code] = lt.description || lt.code;
      });

      const formattedBalances = (balances || []).map(b => ({
        id: String(b.ID),
        leaveType: leaveTypeMap[b.leaveType_code] || b.leaveType_code,
        accruedDays: Number(b.accruedDays || 0),
        usedDays: Number(b.usedDays || 0),
        balance: Number(b.accruedDays || 0) - Number(b.usedDays || 0)
      }));

      return {
        success: true,
        message: `Retrieved ${formattedBalances.length} balance(s)`,
        balances: formattedBalances,
        count: formattedBalances.length
      };
    } catch (error) {
      console.error("getEmployeeLeaveBalance error:", error);
      return { success: false, message: "An error occurred retrieving leave balances", balances: [], count: 0 };
    }
  });

  // ACTION: leaveRequests
  this.on("leaveRequests", async (req) => {
    const tx = cds.transaction(req);
    const { employeeID } = req.data;

    if (!employeeID) {
      return { success: false, message: "Employee ID is required", requests: [], count: 0 };
    }

    try {
      const requests = await tx.run(
        SELECT.from(LeaveRequests)
          .columns(
            "ID", "empname", "employee_employeeId",
            "leaveType_code", "startDate", "endDate",
            "daysRequested", "reason", "status",
            "submittedAt", "approvedBy", "approvedAt", "managerComments"
          )
          .where({ employee_employeeId: employeeID })
          .orderBy({ submittedAt: "desc" })
      );

      const leaveTypes = await tx.run(SELECT.from(LeaveTypes).columns("code", "description"));
      const leaveTypeMap = {};
      (leaveTypes || []).forEach(lt => {
        leaveTypeMap[lt.code] = lt.description || lt.code;
      });

      const formattedRequests = [];
      for (const r of requests || []) {
        let empname = r.empname;
        if (!empname || empname === r.employee_employeeId) {
          empname = await getEmployeeName(tx, r.employee_employeeId);
        }

        formattedRequests.push({
          id: String(r.ID),
          empname,
          employeeId: r.employee_employeeId || "",
          leaveType: leaveTypeMap[r.leaveType_code] || r.leaveType_code,
          leaveTypeCode: r.leaveType_code,
          startDate: r.startDate,
          endDate: r.endDate,
          daysRequested: Number(r.daysRequested || 0),
          reason: r.reason || "",
          status: r.status || "Pending",
          submittedAt: r.submittedAt,
          approvedBy: r.approvedBy || "",
          approvedAt: r.approvedAt || null,
          managerComments: r.managerComments || ""
        });
      }

      return {
        success: true,
        message: `Retrieved ${formattedRequests.length} leave request(s)`,
        requests: formattedRequests,
        count: formattedRequests.length
      };
    } catch (error) {
      console.error("leaveRequests error:", error);
      return { success: false, message: "An error occurred retrieving leave requests", requests: [], count: 0 };
    }
  });
});