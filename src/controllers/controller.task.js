import { SubtaskGenerationAgent, TaskGenerationAgent } from "../ai/agent.js";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { getCustomerAccessFilter } from "./controller.customer.js";



// ==================================================================
// 🏢 ADMIN CONTROLLERS (For CRM Portal)
// ==================================================================

export const createAdminTask = async (req, res, next) => {
  try {
    const adminId = req.admin.id || req.admin._id;
    
    // Accept assignedToIds (Array) instead of assignedToId
    const { title, description, priority, dueDate, assignedToIds, subTasks } = req.body;

    if (!title || !assignedToIds || !Array.isArray(assignedToIds) || assignedToIds.length === 0) {
      throw new ApiError(400, "Title and at least one Assigned Employee are required");
    }

    const validSubTasks = subTasks && Array.isArray(subTasks) 
      ? subTasks.filter(st => st.title && st.title.trim() !== "")
      : [];

    // Loop through every selected employee and create a task
    const taskPromises = assignedToIds.map(empId => {
      const taskData = {
        title,
        description,
        priority: priority || "medium",
        dueDate: dueDate ? new Date(dueDate) : null,
        assignedToId: empId,
        createdById: adminId,
      };

      if (validSubTasks.length > 0) {
        taskData.subTasks = {
          create: validSubTasks.map((st) => ({
            title: st.title,
            description: st.description || null,
            createdById: empId, 
          })),
        };
      }

      return prisma.task.create({
        data: taskData,
        include: {
          assignedTo: { select: { customerName: true, Email: true } },
          subTasks: true 
        }
      });
    });

    const newTasks = await prisma.$transaction(taskPromises);

    res.status(201).json({ 
      success: true, 
      message: `Task assigned successfully to ${newTasks.length} employees`, 
      data: newTasks 
    });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};



export const getAdminTasks = async (req, res, next) => {
  try {
    const { 
      search, 
      status, 
      priority, 
      date, 
      exactDate, // <--- NEW: Specific Calendar Date
      employeeId, 
      limit = 100, 
      skip = 0 
    } = req.query;

    let AND = [];

    // 1. Search by Title
    if (search) {
      AND.push({ title: { contains: search.trim() } });
    }

    // 2. Exact Match Filters
    if (status && status !== 'all') AND.push({ status });
    if (priority && priority !== 'all') AND.push({ priority });
    if (employeeId && employeeId !== 'all') AND.push({ assignedToId: employeeId });

    // 3. Date Math Logic (Exact vs Presets)
    if (exactDate) {
      // Admin picked a specific date from the calendar
      const startOfDay = new Date(exactDate);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(exactDate);
      endOfDay.setHours(23, 59, 59, 999);

      AND.push({ dueDate: { gte: startOfDay, lte: endOfDay } });
    } 
    else if (date && date !== 'all') {
      // Admin used a relative preset (today, overdue, upcoming)
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      if (date === 'today') {
        AND.push({ dueDate: { gte: todayStart, lte: todayEnd } });
      } else if (date === 'overdue') {
        AND.push({ dueDate: { lt: todayStart }, status: { not: 'completed' } });
      } else if (date === 'upcoming') {
        AND.push({ dueDate: { gt: todayEnd } });
      }
    }

    const where = AND.length > 0 ? { AND } : {};

    // 4. Fetch from Database
    const tasks = await prisma.task.findMany({
      where,
      include: {
        assignedTo: {
          select: { customerName: true, Email: true, ContactNumber: true, id:true }
        },
        subTasks: {
          orderBy: { createdAt: 'asc' } 
        },
        _count: {
          select: { subTasks: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      skip: Number(skip)
    });

    res.status(200).json({ 
      success: true, 
      count: tasks.length, 
      data: tasks 
    });

  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

export const updateAdminTask = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, priority, dueDate, status, assignedToId } = req.body;

    const updatedTask = await prisma.task.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(description !== undefined && { description }),
        ...(priority && { priority }),
        ...(dueDate !== undefined && { dueDate: dueDate ? new Date(dueDate) : null }),
        ...(status && { status }),
        ...(assignedToId && { assignedToId }),
      }
    });

    res.status(200).json({ success: true, message: "Task updated", data: updatedTask });
  } catch (error) {
    if (error.code === "P2025") return next(new ApiError(404, "Task not found"));
    next(new ApiError(500, error.message));
  }
};

export const deleteAdminTask = async (req, res, next) => {
  try {
    const { taskIds } = req.body; // Expecting an array of IDs for bulk delete support

    if (!taskIds || taskIds.length === 0) {
      throw new ApiError(400, "Please provide an array of taskIds to delete");
    }

    // Prisma onDelete: Cascade will automatically wipe the related subTasks!
    await prisma.task.deleteMany({
      where: { id: { in: taskIds } },
    });

    res.status(200).json({ success: true, message: "Tasks deleted successfully" });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};


// ==================================================================
// 🧑‍💻 EMPLOYEE CONTROLLERS (For Staff Workspace)
// ==================================================================


export const getEmployeeTasks = async (req, res, next) => {
  try {
    // Assuming req.employee is set by your protectEmployeeRoute middleware
    const employeeId = req.employee.id; 

    const { 
      search, 
      status, 
      priority, 
      date, 
      exactDate, 
      limit = 100, 
      skip = 0 
    } = req.query;

    // VERY IMPORTANT: Lock query strictly to this employee
    let AND = [{ assignedToId: employeeId }];

    // 1. Search by Title or Description
    if (search) {
      AND.push({
        OR: [
          { title: { contains: search.trim() } },
          { description: { contains: search.trim() } }
        ]
      });
    }

    // 2. Exact Match Filters
    if (status && status !== 'all') AND.push({ status });
    if (priority && priority !== 'all') AND.push({ priority });

    // 3. Date Math Logic (Exact Calendar vs Presets)
    if (exactDate) {
      const startOfDay = new Date(exactDate);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(exactDate);
      endOfDay.setHours(23, 59, 59, 999);

      AND.push({ dueDate: { gte: startOfDay, lte: endOfDay } });
    } 
    else if (date && date !== 'all') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      if (date === 'today') {
        AND.push({ dueDate: { gte: todayStart, lte: todayEnd } });
      } else if (date === 'overdue') {
        AND.push({ dueDate: { lt: todayStart }, status: { not: 'completed' } });
      } else if (date === 'upcoming') {
        AND.push({ dueDate: { gt: todayEnd } });
      }
    }

    const where = { AND };

   // 4. Fetch from Database
    const tasks = await prisma.task.findMany({
      where,
      include: {
        // FIXED: Changed createdByRef to createdBy based on your Prisma schema
        createdBy: { 
          select: { name: true, role: true }
        },
        subTasks: {
          orderBy: { createdAt: 'asc' } 
        }
      },
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      skip: Number(skip)
    });

    // Transform payload so the frontend gets exactly what it expects
    const formattedTasks = tasks.map(t => ({
      ...t,
      createdBy: { 
        name: t.createdBy?.name || "Admin", 
        role: t.createdBy?.role || "Admin" 
      }
    }));

    res.status(200).json({ 
      success: true, 
      count: formattedTasks.length, 
      data: formattedTasks 
    });

  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

export const updateEmployeeTaskStatus = async (req, res, next) => {
  try {
    const employeeId = req.employee.id;
    const { id } = req.params;
    const { status } = req.body; // Expects: 'todo', 'in_progress', 'under_review', 'completed'

    // Verify ownership before updating
    const task = await prisma.task.findFirst({
      where: { id, assignedToId: employeeId }
    });

    if (!task) throw new ApiError(404, "Task not found or not assigned to you");

    const updatedTask = await prisma.task.update({
      where: { id },
      data: { status }
    });

    res.status(200).json({ success: true, message: "Task status updated", data: updatedTask });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

// --- SUBTASK CONTROLLERS ---

export const createSubTask = async (req, res, next) => {
  try {
    const employeeId = req.employee.id;
    const { taskId, title, description } = req.body;

    if (!title || !taskId) throw new ApiError(400, "Task ID and Title are required");

    // Ensure the parent task belongs to this employee
    const parentTask = await prisma.task.findFirst({
      where: { id: taskId, assignedToId: employeeId }
    });

    if (!parentTask) throw new ApiError(404, "Parent task not found or access denied");

    const newSubTask = await prisma.subTask.create({
      data: {
        title,
        description: description || null,
        taskId,
        createdById: employeeId
      }
    });

    res.status(201).json({ success: true, data: newSubTask });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

export const toggleSubTask = async (req, res, next) => {
  try {
    const employeeId = req.employee.id;
    const { id } = req.params;
    const { isCompleted } = req.body; // Boolean

    // Ensure subtask belongs to this employee
    const subTask = await prisma.subTask.findFirst({
      where: { id, createdById: employeeId }
    });

    if (!subTask) throw new ApiError(404, "Subtask not found");

    const updated = await prisma.subTask.update({
      where: { id },
      data: { isCompleted }
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

export const deleteSubTask = async (req, res, next) => {
  try {
    const employeeId = req.employee.id;
    const { id } = req.params;

    const subTask = await prisma.subTask.findFirst({
      where: { id, createdById: employeeId }
    });

    if (!subTask) throw new ApiError(404, "Subtask not found");

    await prisma.subTask.delete({ where: { id } });

    res.status(200).json({ success: true, message: "Subtask removed" });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};



// ai workspace 

// ---------------------------------------------
// AI GENERATE SUBTASKS
// ---------------------------------------------
export const generateSubtasksAI = async (req, res, next) => {
  try {
    const { title, description, assignedToId } = req.body;

    if (!title) {
      throw new ApiError(400, "Task title is required to generate subtasks");
    }

    let employeeContext = {};

    // If an employee is already selected, fetch their data to give the AI context
    // (e.g., if the AI knows they are an "Accountant", it writes better steps)
    if (assignedToId) {
      const employee = await prisma.customer.findUnique({
        where: { id: assignedToId },
        select: {
          customerName: true,
          CustomerType: true, // Their job role
          Description: true,  // Any specific notes about them
        }
      });
      if (employee) employeeContext = employee;
    }

    // Call your new AI Agent
    const generatedSubtasks = await SubtaskGenerationAgent(
      title, 
      description, 
      employeeContext
    );

    // generatedSubtasks is expected to be an array of objects: [{ title: "", description: "" }]
    res.status(200).json({
      success: true,
      message: "Subtasks generated successfully",
      data: generatedSubtasks
    });

  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};




export const assignTaskViaAI = async (req, res, next) => {
  try {
    const { prompt, assignedToIds } = req.body; // Expecting an array
    const adminId = req.admin.id || req.admin._id;
 
    if (!prompt || !assignedToIds || !Array.isArray(assignedToIds) || assignedToIds.length === 0) {
      throw new ApiError(400, "Prompt and at least one Employee ID are required");
    }
 
    // 1. Get Employee Contexts for all selected
    const employeesList = await prisma.customer.findMany({
      where: { id: { in: assignedToIds } },
      select: { id: true, customerName: true, Email: true, CustomerType: true }
    });
 
    if (employeesList.length === 0) throw new ApiError(404, "Employees not found");
 
    // 2. Let AI generate the task structure based on the prompt & team size
    const aiTaskData = await TaskGenerationAgent(prompt, employeesList);
 
    // 3. Save to Database for EVERY employee in ONE atomic transaction
    const taskPromises = assignedToIds.map(empId => {
      return prisma.task.create({
        data: {
          title: aiTaskData.title,
          description: aiTaskData.description,
          priority: aiTaskData.priority || "medium",
          status: "todo",
          assignedToId: empId,
          createdById: adminId,
          subTasks: {
            create: aiTaskData.subTasks.map(st => ({
              title: st.title,
              description: st.description,
              createdById: empId
            }))
          }
        },
        include: { subTasks: true }
      });
    });
 
    const newTasks = await prisma.$transaction(taskPromises);
 
    res.status(201).json({
      success: true,
      message: `AI Agent successfully assigned tasks to ${newTasks.length} employees!`,
      data: newTasks,
      aiSummary: aiTaskData.executionSummary // { overview, rationale[], highlights[], objectives[] }
    });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};