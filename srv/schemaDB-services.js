// srv/schemaDB-service.js
const cds = require("@sap/cds");
const bcrypt = require("bcryptjs");

module.exports = cds.service.impl(async function () {
  const { Employees, LeaveRequests, LeaveBalances, LeaveTypes, Approvals } =
    this.entities;

  // ---------- Utilities ----------
  function calculateDays(start, end) {
    return (
      Math.ceil((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1
    );
  }

  const fail = (message) => ({ success: false, message });

  async function findEmployeeByEmail(email) {
    if (!email) return null;
    return await SELECT.one.from(Employees).where({ email });
  }

  async function findLeaveByEmail(employeeId) {
    if (!employeeId) return null;
    return await SELECT.from(LeaveBalances).where({
      employee_employeeId: employeeId,
    });
  }

  // ---------- LEAVE MANAGEMENT HOOKS ----------
  this.before("CREATE", LeaveRequests, async (req) => {
    const { employee_employeeId, leaveType_code, startDate, endDate } =
      req.data;

    if (new Date(startDate) >= new Date(endDate)) {
      throw new Error("End date must be after start date.");
    }

    const balanceRow = await SELECT.one
      .from(LeaveBalances)
      .where({ employee_employeeId, leaveType_code });

    const daysRequested = calculateDays(startDate, endDate);
    const available = balanceRow
      ? Number(balanceRow.accruedDays || 0) - Number(balanceRow.usedDays || 0)
      : 0;

    if (available < daysRequested) {
      throw new Error("Insufficient leave balance.");
    }

    const overlaps = await SELECT.from(LeaveRequests).where({
      employee_employeeId,
      startDate: { "<=": endDate },
      endDate: { ">=": startDate },
      status: { "!=": "Rejected" },
    });

    if (overlaps.length > 0) {
      throw new Error("Overlapping leave request exists.");
    }

    req.data.daysRequested = daysRequested;
    req.data.submittedAt = new Date();
  });

  this.after("CREATE", LeaveRequests, async (data) => {
    if (data.status === "Approved") {
      await UPDATE(LeaveBalances)
        .set({ usedDays: { "+=": data.daysRequested } })
        .where({
          employee_employeeId: data.employee_employeeId,
          leaveType_code: data.leaveType_code,
        });
    }
  });

  this.on("submitLeaveRequest", async (req) => {
    const { employeeId, leaveTypeCode, startDate, endDate, reason } =
      req.data;

    const employee = await SELECT.one
      .from(Employees)
      .where({ employeeId });
    const leaveType = await SELECT.one
      .from(LeaveTypes)
      .where({ code: leaveTypeCode });

    if (!employee || !leaveType) {
      throw new Error("Invalid employee or leave type.");
    }

    const request = await INSERT.into(LeaveRequests).entries({
      employee_employeeId: employeeId,
      leaveType_code: leaveTypeCode,
      startDate,
      endDate,
      reason,
      status: "Pending",
    });

    return request;
  });

  this.on("approveLeaveRequest", async (req) => {
    const { requestId, approverId, comments } = req.data;

    const request = await SELECT.one
      .from(LeaveRequests)
      .where({ ID: requestId });
    if (!request || request.status !== "Pending") {
      throw new Error("Invalid or non-pending request.");
    }

    await UPDATE(LeaveRequests)
      .set({
        status: "Approved",
        approvedAt: new Date(),
        approvedBy: approverId,
      })
      .where({ ID: requestId });

    await INSERT.into(Approvals).entries({
      leaveRequest_ID: requestId,
      approverId,
      status: "Approved",
      comments,
      approvedAt: new Date(),
    });

    await UPDATE(LeaveBalances)
      .set({ usedDays: { "+=": request.daysRequested } })
      .where({
        employee_employeeId: request.employee_employeeId,
        leaveType_code: request.leaveType_code,
      });

    return await SELECT.one.from(LeaveRequests).where({ ID: requestId });
  });

  this.on("rejectLeaveRequest", async (req) => {
    const { requestId, approverId, comments } = req.data;

    const request = await SELECT.one
      .from(LeaveRequests)
      .where({ ID: requestId });
    if (!request || request.status !== "Pending") {
      throw new Error("Invalid or non-pending request.");
    }

    await UPDATE(LeaveRequests)
      .set({ status: "Rejected" })
      .where({ ID: requestId });

    await INSERT.into(Approvals).entries({
      leaveRequest_ID: requestId,
      approverId,
      status: "Rejected",
      comments,
      approvedAt: new Date(),
    });

    return await SELECT.one.from(LeaveRequests).where({ ID: requestId });
  });

  this.after("READ", LeaveBalances, (each) => {
    each.balance =
      Number(each.accruedDays || 0) - Number(each.usedDays || 0);
  });

  // ==================== LOGIN ACTION ====================
  this.on("login", async (req) => {
    const { email, password } = req.data;

    if (!email || !password) {
      return {
        success: false,
        message: "Email and password are required",
        employee: null,
      };
    }

    try {
      const emp = await SELECT.one.from(Employees).where({ email });

      if (!emp) {
        return {
          success: false,
          message: "Invalid email or password",
          employee: null,
        };
      }

      const isPasswordValid = await bcrypt.compare(password, emp.password);

      if (!isPasswordValid) {
        return {
          success: false,
          message: "Invalid email or password",
          employee: null,
        };
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
          designation,
        },
      };
    } catch (error) {
      console.error("Login error:", error);
      return {
        success: false,
        message: "An error occurred during login. Please try again.",
        employee: null,
      };
    }
  });

  // ==================== REGISTRATION ACTION ====================
  this.on("register", async (req) => {
    console.log("[register] 📋 Received registration request");

    // Early exit if no data
    if (!req.data) {
      console.log("[register] ❌ No request data provided");
      return {
        success: false,
        message: "No registration data provided",
      };
    }

    // Extract and normalize inputs
    let {
      firstName = "",
      lastName = "",
      email = "",
      password = "",
      managerId = "",
    } = req.data;

    firstName = String(firstName || "").trim();
    lastName = String(lastName || "").trim();
    email = String(email || "").trim().toLowerCase();
    password = String(password || "");
    managerId = String(managerId || "").trim();

    console.log("[register] Input validated and normalized");

    // ---- Basic Validation ----
    if (!firstName || !lastName || !email || !password) {
      console.log("[register] ❌ Missing required fields");
      return {
        success: false,
        message:
          "Missing required fields (firstName, lastName, email, password)",
      };
    }

    if (password.length < 6) {
      console.log("[register] ❌ Password too short");
      return {
        success: false,
        message: "Password must be at least 6 characters",
      };
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      console.log("[register] ❌ Invalid email format");
      return {
        success: false,
        message: "Invalid email address",
      };
    }

    if (managerId && managerId.length > 10) {
      console.log("[register] ❌ Manager ID too long");
      return {
        success: false,
        message: "Manager ID must be at most 10 characters",
      };
    }

    try {
      // ---- Check if email already exists ----
   

      let existingEmp = null;
      try {
        existingEmp = await SELECT.one.from(this.entities.Employees).where({ email });
      } catch (checkErr) {
        console.log("[register] ⚠️ Email check query failed:", checkErr.message);
      }

      if (existingEmp) {
        console.log("[register] ⚠️ Email already registered:", email);
        return {
          success: false,
          message: "User with this email already exists",
        };
      }
      console.log("[register] ✅ Email is available");

      // ---- Hash password ----
      console.log("[register] 🔐 Hashing password");
      let hashedPassword = "";
      try {
        const saltRounds = 10;
        hashedPassword = await bcrypt.hash(password, saltRounds);
        console.log("[register] ✅ Password hashed");
      } catch (hashErr) {
        console.error("[register] ❌ Password hash failed:", hashErr.message);
        return {
          success: false,
          message: "Failed to process password",
        };
      }

      // ---- Auto-generate Employee ID ----
      console.log("[register] 🔢 Generating employee ID");
      let employeeId = "E1001";

      try {
        const lastEmployee = await SELECT.one
          .from(this.entities.Employees)
          .columns("employeeId")
          .orderBy({ employeeId: "desc" });

        if (lastEmployee && lastEmployee.employeeId) {
          const currentId = lastEmployee.employeeId;
          console.log("[register] Last ID:", currentId);
          const numPart = parseInt(currentId.replace(/[^0-9]/g, ""), 10);
          if (!isNaN(numPart)) {
            employeeId = "E" + String(numPart + 1).padStart(4, "0");
          }
        }
      } catch (idErr) {
        console.log("[register] ⚠️ ID generation error:", idErr.message);
        employeeId = "E1001";
      }

      console.log("[register] ✅ Generated ID:", employeeId);

      // ---- Insert Employee ----
      console.log("[register] 💾 Inserting employee");

      const newEmployeeData = {
        employeeId,
        firstName,
        lastName,
        email,
        department: "General",
        managerId: managerId || null,
        password: hashedPassword,
      };

      try {
        await INSERT.into(this.entities.Employees).entries(newEmployeeData);
        console.log("[register] ✅ Employee inserted");
      } catch (insertErr) {
        console.error("[register] ❌ Insert failed:", insertErr.message);
        return {
          success: false,
          message: "Failed to create employee: " + insertErr.message,
        };
      }

      // ---- Verify Employee ----
      console.log("[register] 🔍 Verifying employee");

      let employee = null;
      try {
        employee = await SELECT.one
          .from(this.entities.Employees)
          .columns(
            "employeeId",
            "firstName",
            "lastName",
            "email",
            "department",
            "managerId"
          )
          .where({ employeeId });
      } catch (verifyErr) {
        console.error("[register] ❌ Verification query failed:", verifyErr.message);
        return {
          success: false,
          message: "Failed to verify employee creation",
        };
      }

      if (!employee) {
        console.log("[register] ❌ Employee not found after insert");
        return {
          success: false,
          message: "Failed to verify employee creation",
        };
      }

      console.log("[register] ✅ Registration complete");

      return {
        success: true,
        message:"Register Success",
        employeeId,
        employee: {
          employeeID: String(employee.employeeId),
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          department: employee.department,
          managerId: employee.managerId || null,
        },
      };
    } catch (e) {
      console.error("========================================");
      console.error("❌ UNEXPECTED REGISTRATION ERROR");
      console.error("========================================");
      console.error("Error Name:", e.name);
      console.error("Error Message:", e.message);
      console.error("Error Stack:", e.stack);
      console.error("========================================");

      return {
        success: false,
        message: e.message || "Registration failed. Please try again.",
      };
    }
  });

  // ---------- GET EMPLOYEE DATA ----------
  this.on("getEmployeeData", async (req) => {
    const { email } = req.data;

    if (!email) {
      return {
        success: false,
        message: "Email is required",
      };
    }

    try {
      const employee = await SELECT.one.from(this.entities.Employees).where({ email });

      if (!employee) {
        return {
          success: false,
          message: "Employee not found",
        };
      }

      const balances = await SELECT.from(this.entities.LeaveBalances).columns(
        "ID",
        "accruedDays",
        "usedDays",
        "balance",
        "leaveType_code",
        "employee_employeeId"
      ).where({ employee_employeeId: employee.employeeId });

      const leaveBalances = (balances || []).map((b) => ({
        id: String(b.ID),
        accruedDays: b.accruedDays,
        usedDays: b.usedDays,
        balance: b.balance,
        leaveTypeCode: b.leaveType_code || "",
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
          managerID: employee.managerId || "",
        },
        leaveBalances,
      };
    } catch (error) {
      console.error("getEmployeeData error:", error);
      return {
        success: false,
        message: "An error occurred retrieving employee data",
      };
    }
  });
});