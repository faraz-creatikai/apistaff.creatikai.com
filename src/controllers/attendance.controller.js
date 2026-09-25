import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";

const parseJSON = (field) => {
  if (!field) return [];
  if (typeof field === "string") {
    try {
      return JSON.parse(field);
    } catch {
      return [];
    }
  }
  return field;
};

const transformCustomer = async (c, admin = null) => {
  const adminId = admin?.id || admin?._id;

  const base = {
    ...c,
    _id: c.id,
    CustomerImage: parseJSON(c.CustomerImage),
    SitePlan: parseJSON(c.SitePlan),
  };

  // Hide contact number for assigned customers (not self-created)
  if (
    admin &&
    (admin.role === "agent" || admin.role === "user") &&
    base.CreatedById !== adminId
  ) {
    base.ContactNumber = "forbidden"; // or "XXXXXXXXXX"
  }

  const [
    campaignDoc,
    typeDoc,
    subTypeDoc,
    cityDoc,
    locationDoc,
    subLocationDoc,
    assignToDoc,
    createdByDoc,
  ] = await Promise.all([
   /*  prisma.campaign.findFirst({
      where: { Name: c.Campaign },
      select: { id: true, Name: true },
    }),
    prisma.type.findFirst({
      where: { Name: c.CustomerType },
      select: { id: true, Name: true },
    }),
    prisma.subType.findFirst({
      where: { Name: c.CustomerSubType },
      select: { id: true, Name: true },
    }),
    prisma.city.findFirst({
      where: { Name: c.City },
      select: { id: true, Name: true },
    }),
    prisma.location.findFirst({
      where: { Name: c.Location },
      select: { id: true, Name: true },
    }),
    prisma.subLocation.findFirst({
      where: { Name: c.SubLocation },
      select: { id: true, Name: true },
    }), */
    c.AssignToId
      ? prisma.admin.findUnique({
        where: { id: c.AssignToId },
        select: { id: true, name: true, email: true, role: true, city: true },
      })
      : null,
    c.CreatedBy
      ? prisma.admin.findUnique({
        where: { id: c.CreatedBy },
        select: { id: true, name: true, email: true },
      })
      : null,
  ]);

  return {
    ...base,
  /*   Campaign: campaignDoc
      ? { _id: campaignDoc.id, Name: campaignDoc.Name }
      : { _id: null, Name: c.Campaign || "" },

    CustomerType: typeDoc
      ? { _id: typeDoc.id, Name: typeDoc.Name }
      : { _id: null, Name: c.CustomerType || "" },

    CustomerSubType: subTypeDoc
      ? { _id: subTypeDoc.id, Name: subTypeDoc.Name }
      : { _id: null, Name: c.CustomerSubType || "" },

    City: cityDoc
      ? { _id: cityDoc.id, Name: cityDoc.Name }
      : { _id: null, Name: c.City || "" },

    Location: locationDoc
      ? { _id: locationDoc.id, Name: locationDoc.Name }
      : { _id: null, Name: c.Location || "" },

    SubLocation: subLocationDoc
      ? { _id: subLocationDoc.id, Name: subLocationDoc.Name }
      : { _id: null, Name: c.SubLocation || "" }, */

    AssignTo: assignToDoc
      ? {
        _id: assignToDoc.id,
        name: assignToDoc.name,
        email: assignToDoc.email,
        role: assignToDoc.role,
        city: assignToDoc.city,
      }
      : null,

    CreatedBy: createdByDoc
      ? {
        _id: createdByDoc.id,
        name: createdByDoc.name,
        email: createdByDoc.email,
      }
      : null,
  };
};

// Utility to generate token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

// Helper to get local date string YYYY-MM-DD
const getLocalDateString = (date) => {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().split("T")[0];
};

// ---------------------------------------------
// EMPLOYEE LOGIN
// ---------------------------------------------
export const employeeLogin = async (req, res, next) => {
  try {
    const { Email, Password } = req.body;

    if (!Email || !Password) throw new ApiError(400, "Missing login details");

    const employee = await prisma.customer.findFirst({
      where: { Email },
    });

    if (!employee || !employee.Password) {
      throw new ApiError(404, "Employee account not found or access not granted");
    }

    const isPasswordCorrect = await bcrypt.compare(Password, employee.Password);
    if (!isPasswordCorrect) throw new ApiError(401, "Invalid credentials");

    const token = generateToken(employee.id);

    res.cookie("employeeToken", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      success: true,
      employee: {
        id: employee.id,
        name: employee.customerName,
        email: employee.Email,
      },
      token,
      message: "Login successful",
    });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

// ---------------------------------------------
// CHECK EMPLOYEE AUTHENTICATION
// ---------------------------------------------
export const checkEmployeeAuth = async (req, res, next) => {
  try {
    // Because this route uses protectEmployeeRoute, req.employee is already verified.
    // We just return the safe, non-sensitive payload back to the frontend.
    res.status(200).json({
      success: true,
      employee: {
        id: req.employee.id,
        name: req.employee.customerName || req.employee.name,
        email: req.employee.Email || req.employee.email,
        CustomerImage: req.employee.CustomerImage // Optional: include if needed for global avatar state
      }
    });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

// ---------------------------------------------
// LOGOUT EMPLOYEE (Clear HTTP-Only Cookie)
// ---------------------------------------------
export const employeeLogout = async (req, res, next) => {
  try {
    // Replace "employeeToken" with whatever you named your cookie during login
    res.cookie("employeeToken", "", {
      httpOnly: true,
      expires: new Date(0), // Instantly expires the cookie
    });
    
    res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};







// ---------------------------------------------
// CLOCK IN (Employee Route)
// ---------------------------------------------
export const clockIn = async (req, res, next) => {
  try {
    const customerId = req.employee.id;
    const now = new Date();
    const dateString = getLocalDateString(now);

    // Check if already clocked in today
    const existing = await prisma.customerAttendance.findUnique({
      where: { customerId_dateString: { customerId, dateString } }
    });

    if (existing) {
      throw new ApiError(400, "You have already clocked in today");
    }

    // RULE: If starting after 2:00 PM (14:00), mark as half_day
    const currentHour = now.getHours();
    let initialStatus = "present";
    if (currentHour >= 14) {
      initialStatus = "half_day";
    }

    const attendance = await prisma.customerAttendance.create({
      data: {
        customerId,
        dateString,
        clockIn: now,
        status: initialStatus,
      }
    });

    res.status(200).json({ success: true, message: "Clocked in successfully", attendance });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

// ---------------------------------------------
// CLOCK OUT (Employee Route)
// ---------------------------------------------
export const clockOut = async (req, res, next) => {
  try {
    const customerId = req.employee.id;
    const now = new Date();
    const dateString = getLocalDateString(now);

    const attendance = await prisma.customerAttendance.findUnique({
      where: { customerId_dateString: { customerId, dateString } }
    });

    if (!attendance) throw new ApiError(404, "No clock-in record found for today");
    if (attendance.clockOut) throw new ApiError(400, "You have already clocked out today");

    // RULE: Auto-cap at 6:30 PM (18:30)
    let finalClockOut = now;
    const endOfDayCap = new Date(now);
    endOfDayCap.setHours(18, 30, 0, 0);

    if (finalClockOut > endOfDayCap) {
      finalClockOut = endOfDayCap;
    }

    // Calculate total minutes
    const diffMs = finalClockOut.getTime() - attendance.clockIn.getTime();
    const totalMinutes = Math.floor(diffMs / 60000); // ms to minutes

    // RULE: Recalculate Status based on hours worked
    // Office hours: 10:00 AM to 6:30 PM = 8.5 hours (510 minutes)
    // Let's say less than 5 hours (300 mins) is a half day.
    let finalStatus = attendance.status;
    if (totalMinutes < 300) {
      finalStatus = "half_day";
    }

    const updated = await prisma.customerAttendance.update({
      where: { id: attendance.id },
      data: {
        clockOut: finalClockOut,
        totalMinutes,
        status: finalStatus,
        isAutoStopped: now > endOfDayCap // true if they clocked out after 6:30
      }
    });

    res.status(200).json({ success: true, message: "Clocked out successfully", data: updated });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};



// ---------------------------------------------
// ADMIN UPDATE ATTENDANCE (Admin Route)
// ---------------------------------------------
export const adminUpdateAttendance = async (req, res, next) => {
  try {
    const adminId = req.admin.id;
    // Note: the frontend will send `employeeId`, but we map it to `customerId`
    const { employeeId, dateString, status, clockIn, clockOut, notes } = req.body;

    if (!employeeId || !dateString || !status) {
      throw new ApiError(400, "Missing required fields");
    }

    let calculatedMinutes = 0;
     let finalStatus = status;
    if (clockIn && clockOut) {
      const diffMs = new Date(clockOut).getTime() - new Date(clockIn).getTime();
      calculatedMinutes = Math.max(0, Math.floor(diffMs / 60000));

        if (finalStatus === "present" && calculatedMinutes < 300) {
        finalStatus = "half_day";
      }
    }

    // Upsert means: Update if exists, Create if it doesn't exist
    const attendance = await prisma.customerAttendance.upsert({
      where: {
        customerId_dateString: {
          customerId: employeeId,
          dateString: dateString
        }
      },
      update: {
         status: finalStatus,
        clockIn: clockIn ? new Date(clockIn) : null,
        clockOut: clockOut ? new Date(clockOut) : null,
        totalMinutes: calculatedMinutes,
        notes,
        markedByAdminId: adminId
      },
      create: {
        customerId: employeeId,
        dateString,
        status: finalStatus,
        clockIn: clockIn ? new Date(clockIn) : null,
        clockOut: clockOut ? new Date(clockOut) : null,
        totalMinutes: calculatedMinutes,
        notes,
        markedByAdminId: adminId
      }
    });

    res.status(200).json({ success: true, message: "Attendance manually updated", data: attendance });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};


// ---------------------------------------------
// ADMIN VIEW ATTENDANCE REPORT (WEEKLY GRID OPTIMIZED)
// ---------------------------------------------
export const getAdminAttendanceReport = async (req, res, next) => {
  try {
    const { startDate, endDate, search, statuses, limit = 50, skip = 0 } = req.query;

    // 1. Build the Customer (Employee) query
    const customerWhere = {};

    // Search by name
    if (search) {
      customerWhere.customerName = { contains: search };
    }

    // Filter by specific statuses within the week (e.g., show only people who had a "leave")
    // This uses Prisma's relational filtering!
    if (statuses) {
      const statusArray = statuses.split(","); // e.g., "leave,absent"
      customerWhere.attendanceLogs = {
        some: {
          dateString: { gte: startDate, lte: endDate },
          status: { in: statusArray }
        }
      };
    }

    // 2. Fetch the paginated Employees
    const customers = await prisma.customer.findMany({
      where: customerWhere,
      select: { id: true, customerName: true, ContactNumber: true, Email: true, CustomerImage: true },
      take: Number(limit),
      skip: Number(skip),
      orderBy: { customerName: 'asc' }
    });

    const customerIds = customers.map(c => c.id);

    // 3. Fetch ONLY the attendance records for these specific employees in this date range
    const records = await prisma.customerAttendance.findMany({
      where: {
        customerId: { in: customerIds },
        dateString: { gte: startDate, lte: endDate }
      }
    });

    // 4. Group the data on the server
    const groupedData = customers.map(emp => {
      const empRecords = records.filter(r => r.customerId === emp.id);
      const weeklyData = {};
      
      empRecords.forEach(r => {
        weeklyData[r.dateString] = r;
      });

      let avatar = null;
      try {
        const imgArray = typeof emp.CustomerImage === "string" ? JSON.parse(emp.CustomerImage) : emp.CustomerImage;
        if (Array.isArray(imgArray) && imgArray.length > 0) {
          avatar = imgArray[0];
        }
      } catch (e) {
        console.error("Failed to parse image for", emp.customerName);
      }

      return {
        employeeId: emp.id,
        employee: { customerName: emp.customerName, ContactNumber: emp.ContactNumber, image: avatar },
        weeklyData
      };
    });

   // 5. Calculate Global Stats for the SELECTED DATE RANGE (Weekly Total)
    const summaryRecords = await prisma.customerAttendance.findMany({
      where: { 
        // 🚨 Changed from dateString: todayStr to use the full week range
        dateString: { gte: startDate, lte: endDate } 
      },
      select: { status: true }
    });

    const summary = { present: 0, half_day: 0, workfromhome: 0, leave: 0, absent: 0 };
    
    summaryRecords.forEach(r => {
      // Safely count the statuses for the whole week
      if (summary[r.status] !== undefined) {
        summary[r.status]++;
      }
    });

    // Return the perfectly formatted payload
    res.status(200).json({
      success: true,
      summary,
      data: groupedData,
      totalFetched: customers.length
    });


  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

// ---------------------------------------------
// EMPLOYEE VIEW OWN ATTENDANCE REPORT
// ---------------------------------------------
// ---------------------------------------------
// EMPLOYEE VIEW OWN ATTENDANCE REPORT
// ---------------------------------------------
// ---------------------------------------------
// EMPLOYEE VIEW OWN ATTENDANCE REPORT (UPDATED WITH WFH)
// ---------------------------------------------
export const getEmployeeAttendanceReport = async (req, res, next) => {
  try {
    const employeeId = req.employee.id;
    const { startDate, endDate } = req.query; 

    // 1. Fetch Profile (Unchanged)
    const employeeData = await prisma.customer.findUnique({
      where: { id: employeeId },
      select: { id: true, customerName: true, Email: true, ContactNumber: true, City: true, Adderess: true, CustomerImage: true }
    });
    if (!employeeData) throw new ApiError(404, "Employee not found");

    let avatar = null;
    try {
      const imgArray = typeof employeeData.CustomerImage === "string" ? JSON.parse(employeeData.CustomerImage) : employeeData.CustomerImage;
      if (Array.isArray(imgArray) && imgArray.length > 0) avatar = imgArray[0];
    } catch (e) {}

    // 2. Fetch records
    const attendanceRecords = await prisma.customerAttendance.findMany({
      where: { customerId: employeeId, dateString: { gte: startDate, lte: endDate } },
      orderBy: { dateString: 'asc' }
    });

    const weeklyData = {};
    let totalMinutesWeek = 0;
    
    attendanceRecords.forEach(r => {
      weeklyData[r.dateString] = r;
      totalMinutesWeek += (r.totalMinutes || 0);
    });

    // 3. Calculate Stats (ADDED workfromhome)
    const stats = {
      present: 0,
      half_day: 0,
      workfromhome: 0, // <-- Added
      absent: 0,
      leave: 0,
      totalHours: (totalMinutesWeek / 60).toFixed(1)
    };

    attendanceRecords.forEach((record) => {
      if (stats[record.status] !== undefined) {
        stats[record.status]++;
      }
    });

    res.status(200).json({
      success: true,
      stats,
      weeklyData,
      employeeProfile: { name: employeeData.customerName, email: employeeData.Email, phone: employeeData.ContactNumber, city: employeeData.City, address: employeeData.Adderess, image: avatar }
    });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

// ---------------------------------------------
// EMPLOYEE MANUAL UPDATE (LEAVE / WFH)
// ---------------------------------------------
export const employeeManualUpdate = async (req, res, next) => {
  try {
    const employeeId = req.employee.id;
    const { dateString, status, notes } = req.body;

    if (!dateString || !status || !notes) {
      throw new ApiError(400, "Date, status, and a reason (notes) are strictly required.");
    }

    // Security Check: Employees can only mark these specific statuses manually
    if (!["leave", "workfromhome"].includes(status)) {
      throw new ApiError(403, "You can only manually request 'Leave' or 'Work From Home'.");
    }

    // Check if a record already exists
    const existingRecord = await prisma.customerAttendance.findUnique({
      where: { customerId_dateString: { customerId: employeeId, dateString } }
    });

    // Prevent overwriting if they already clocked in physically
    if (existingRecord && existingRecord.clockIn) {
      throw new ApiError(400, "Cannot change status manually after clocking in. Contact admin.");
    }

    // Upsert the limited data
    const attendance = await prisma.customerAttendance.upsert({
      where: { customerId_dateString: { customerId: employeeId, dateString } },
      update: { status, notes },
      create: { customerId: employeeId, dateString, status, notes }
    });

    res.status(200).json({ success: true, message: `Successfully marked as ${status.replace("_", " ")}`, data: attendance });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};


export const getEmployeeById = async (req, res, next) => {
  try {
    const admin = req.employee;
    const { id } = req.params;

    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) return next(new ApiError(404, "Customer not found"));

    // role: user → only if assigned to them
    if (admin.role === "user" && customer.AssignToId !== admin.id)
      return next(new ApiError(403, "Access denied"));

    // role: city_admin → only same city
    if (admin.role === "city_admin" && customer.City !== admin.city)
      return next(new ApiError(403, "Access denied"));

    const response = await transformCustomer(customer, admin);
    res.status(200).json(response);
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};



// analytics of attendance

// ---------------------------------------------
// GET ATTENDANCE TREND (AREA CHART DATA)
// ---------------------------------------------
export const getAttendanceTrend = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      throw new ApiError(400, "startDate and endDate are required");
    }

    // Optional: If you want to scope this to specific admins (RBAC)
    // const admin = req.admin;
    // const accessFilter = await getCustomerAccessFilter(admin);

    // 1. Fetch all attendance records in the date range
    const attendanceRecords = await prisma.customerAttendance.findMany({
      where: {
        dateString: { gte: startDate, lte: endDate },
        // customer: accessFilter // Uncomment if RBAC applies
      },
      select: { dateString: true, status: true }
    });

    // 2. Generate a continuous array of dates between start and end
    const getDaysArray = (start, end) => {
      let arr = [];
      for (let dt = new Date(start); dt <= new Date(end); dt.setDate(dt.getDate() + 1)) {
        arr.push(new Date(dt).toISOString().split('T')[0]);
      }
      return arr;
    };
    const dateRange = getDaysArray(startDate, endDate);

    // 3. Map the data into daily aggregations
    const trendData = dateRange.map(dateStr => {
      const dayRecords = attendanceRecords.filter(r => r.dateString === dateStr);
      
      let presentCount = 0;
      let absentCount = 0;

      dayRecords.forEach(r => {
        // Group working statuses into "Present"
        if (['present', 'half_day', 'workfromhome'].includes(r.status)) {
          presentCount++;
        } 
        // Group non-working statuses into "Absent"
        else if (['absent', 'leave'].includes(r.status)) {
          absentCount++;
        }
      });

      // Get Short Day Name (e.g., "Mon", "Tue")
      const dateObj = new Date(dateStr);
      const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });

      return {
        date: dateStr,
        name: dayName,
        Present: presentCount,
        Absent: absentCount
      };
    });

    res.status(200).json({ success: true, data: trendData });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

// ---------------------------------------------
// GET ATTENDANCE OVERVIEW (DONUT CHART DATA)
// ---------------------------------------------
export const getAttendanceOverview = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      throw new ApiError(400, "startDate and endDate are required");
    }

    // Optional: If you want to scope this to specific admins (RBAC)
    // const admin = req.admin;
    // const accessFilter = await getCustomerAccessFilter(admin);

    // Group the attendance records by status within the date range
    const groupedRecords = await prisma.customerAttendance.groupBy({
      by: ['status'],
      _count: { id: true },
      where: {
        dateString: { gte: startDate, lte: endDate },
        // customer: accessFilter // Uncomment if RBAC applies
      }
    });

    let totalRecords = 0;
    
    // Format names and calculate the total
    const formattedData = groupedRecords.map(record => {
      totalRecords += record._count.id;
      
      let displayName = record.status;
      if (displayName === 'half_day') displayName = 'Late / Half Day';
      else if (displayName === 'workfromhome') displayName = 'Work From Home';
      else displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1); // Capitalize 'Present', 'Absent', 'Leave'

      return {
        name: displayName,
        value: record._count.id
      };
    });

    // Calculate percentages and sort highest to lowest
    const finalData = formattedData.map(item => ({
      ...item,
      percentage: totalRecords > 0 ? Math.round((item.value / totalRecords) * 100) : 0
    })).sort((a, b) => b.value - a.value);

    res.status(200).json({
      success: true,
      total: totalRecords,
      data: finalData
    });

  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};