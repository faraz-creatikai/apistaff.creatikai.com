import { SubtaskGenerationAgent, TaskGenerationAgent } from "../ai/agent.js";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { getCustomerAccessFilter } from "./controller.customer.js"; // RESTORED IMPORT

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
        // NOTE: status removed from Parent Task
      };

      if (validSubTasks.length > 0) {
        taskData.subTasks = {
          create: validSubTasks.map((st) => ({
            title: st.title,
            description: st.description || null,
            createdById: empId, // Subtasks belong to Employee
            status: "todo" // New schema requirement
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
    const { search, status, priority, date, exactDate, employeeId, limit = 100, skip = 0 } = req.query;

    let AND = [];

    // 1. Search by Title
    if (search) {
      AND.push({ title: { contains: search.trim() } });
    }

    // 2. Exact Match Filters
    if (priority && priority !== 'all') AND.push({ priority });
    if (employeeId && employeeId !== 'all') AND.push({ assignedToId: employeeId });

    // 3. SubTask Status Filter (Since parent no longer has status)
    if (status && status !== 'all') {
      if (status === 'completed') {
        // Task is only 'completed' if it has subtasks, and ALL are completed
        AND.push({
          subTasks: { some: {}, every: { status: 'completed' } }
        });
      } else {
        // For todo, in_progress, etc., check if ANY subtask has this status
        AND.push({ subTasks: { some: { status } } });
      }
    }

    // 4. Date Logic
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
        AND.push({ dueDate: { lt: todayStart } });
        // Overdue ONLY if subtasks are NOT all completed
        AND.push({
          OR: [
            { subTasks: { some: { status: { not: 'completed' } } } },
            { subTasks: { none: {} } }
          ]
        });
      } else if (date === 'upcoming') {
        AND.push({ dueDate: { gt: todayEnd } });
      }
    }

    const where = AND.length > 0 ? { AND } : {};

    const tasks = await prisma.task.findMany({
      where,
      include: {
        assignedTo: { select: { customerName: true, Email: true, ContactNumber: true, id: true } },
        subTasks: { orderBy: { createdAt: 'asc' } },
        _count: { select: { subTasks: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      skip: Number(skip)
    });

    res.status(200).json({ success: true, count: tasks.length, data: tasks });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

export const updateAdminTask = async (req, res, next) => {
  try {
    const { id } = req.params;
    // Status removed because Parent Tasks don't have statuses anymore
    const { title, description, priority, dueDate, assignedToId } = req.body;

    const updatedTask = await prisma.task.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(description !== undefined && { description }),
        ...(priority && { priority }),
        ...(dueDate !== undefined && { dueDate: dueDate ? new Date(dueDate) : null }),
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
    const { taskIds } = req.body;
    if (!taskIds || taskIds.length === 0) {
      throw new ApiError(400, "Please provide an array of taskIds to delete");
    }

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
    const employeeId = req.employee.id;
    const { search, status, priority, date, exactDate, limit = 100, skip = 0 } = req.query;

    let AND = [{ assignedToId: employeeId }];

    if (search) {
      AND.push({
        OR: [
          { title: { contains: search.trim() } },
          { description: { contains: search.trim() } }
        ]
      });
    }

    if (priority && priority !== 'all') AND.push({ priority });

    // SubTask Status Filtering
    if (status && status !== 'all') {
      if (status === 'completed') {
        AND.push({ subTasks: { some: {}, every: { status: 'completed' } } });
      } else {
        AND.push({ subTasks: { some: { status } } });
      }
    }

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
        AND.push({ dueDate: { lt: todayStart } });
        AND.push({
          OR: [
            { subTasks: { some: { status: { not: 'completed' } } } },
            { subTasks: { none: {} } }
          ]
        });
      } else if (date === 'upcoming') {
        AND.push({ dueDate: { gt: todayEnd } });
      }
    }

    const where = { AND };

    const tasks = await prisma.task.findMany({
      where,
      include: {
        createdBy: { select: { name: true, role: true } },
        subTasks: { orderBy: { createdAt: 'asc' } }
      },
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      skip: Number(skip)
    });

    const formattedTasks = tasks.map(t => ({
      ...t,
      createdBy: {
        name: t.createdBy?.name || "Admin",
        role: t.createdBy?.role || "Admin"
      }
    }));

    res.status(200).json({ success: true, count: formattedTasks.length, data: formattedTasks });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// RESTORED: Acts as a bridge for the UI until you update it.
// If the UI sends a task status update, we apply it to ALL subtasks of that task.
export const updateEmployeeTaskStatus = async (req, res, next) => {
  try {
    const employeeId = req.employee.id;
    const { id } = req.params; // Parent Task ID
    const { status } = req.body;

    // Update all subtasks belonging to this task
    await prisma.subTask.updateMany({
      where: { taskId: id, createdById: employeeId },
      data: { status }
    });

    res.status(200).json({ success: true, message: "Task status applied to subtasks" });
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

    const parentTask = await prisma.task.findFirst({
      where: { id: taskId, assignedToId: employeeId }
    });

    if (!parentTask) throw new ApiError(404, "Parent task not found or access denied");

    const newSubTask = await prisma.subTask.create({
      data: {
        title,
        description: description || null,
        taskId,
        createdById: employeeId,
        status: "todo"
      }
    });

    res.status(201).json({ success: true, data: newSubTask });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

// ---------------------------------------------
// UPDATE INDIVIDUAL SUBTASK STATUS
// ---------------------------------------------
export const updateSubTaskStatus = async (req, res, next) => {
  try {
    const employeeId = req.employee.id;
    const { id } = req.params; // This is the SubTask ID
    const { status } = req.body; // Expects TaskStatus enum ('todo', 'in_progress', 'completed', etc.)

    // 1. Verify the subtask belongs to this employee
    const subTask = await prisma.subTask.findFirst({
      where: { id, createdById: employeeId }
    });

    if (!subTask) {
      throw new ApiError(404, "Subtask not found or access denied");
    }

    // 2. Update just this specific subtask
    const updated = await prisma.subTask.update({
      where: { id },
      data: { status }
    });

    res.status(200).json({ success: true, data: updated, message: "Subtask status updated" });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

// RESTORED: Acts as a bridge for the UI until you update it.
// Translates `isCompleted` boolean into new Enum status.
export const toggleSubTask = async (req, res, next) => {
  try {
    const employeeId = req.employee.id;
    const { id } = req.params;
    const { isCompleted } = req.body; // Old UI sends boolean

    // Map boolean to new enum
    const newStatus = isCompleted ? 'completed' : 'todo';

    const updated = await prisma.subTask.updateMany({
      where: { id, createdById: employeeId },
      data: { status: newStatus }
    });

    if (updated.count === 0) throw new ApiError(404, "Subtask not found");

    res.status(200).json({ success: true, message: "Subtask updated" });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

export const deleteSubTask = async (req, res, next) => {
  try {
    const employeeId = req.employee.id;
    const { id } = req.params;

    const deleted = await prisma.subTask.deleteMany({
      where: { id, createdById: employeeId }
    });

    if (deleted.count === 0) throw new ApiError(404, "Subtask not found");

    res.status(200).json({ success: true, message: "Subtask removed" });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

// ==================================================================
// 🤖 AI WORKSPACE CONTROLLERS
// ==================================================================

export const generateSubtasksAI = async (req, res, next) => {
  try {
    const { title, description, assignedToId } = req.body;

    if (!title) throw new ApiError(400, "Task title is required to generate subtasks");

    let employeeContext = {};
    if (assignedToId) {
      const employee = await prisma.customer.findUnique({
        where: { id: assignedToId },
        select: { customerName: true, CustomerType: true, Description: true }
      });
      if (employee) employeeContext = employee;
    }

    const generatedSubtasks = await SubtaskGenerationAgent(title, description, employeeContext);

    res.status(200).json({ success: true, message: "Subtasks generated successfully", data: generatedSubtasks });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};

export const assignTaskViaAI = async (req, res, next) => {
  try {
    const { prompt, assignedToIds } = req.body;
    const adminId = req.admin.id || req.admin._id;

    if (!prompt || !assignedToIds || !Array.isArray(assignedToIds) || assignedToIds.length === 0) {
      throw new ApiError(400, "Prompt and at least one Employee ID are required");
    }

    const employeesList = await prisma.customer.findMany({
      where: { id: { in: assignedToIds } },
      select: { id: true, customerName: true, Email: true, CustomerType: true }
    });

    if (employeesList.length === 0) throw new ApiError(404, "Employees not found");

    const aiTaskData = await TaskGenerationAgent(prompt, employeesList);

    const taskPromises = assignedToIds.map(empId => {
      return prisma.task.create({
        data: {
          title: aiTaskData.title,
          description: aiTaskData.description,
          priority: aiTaskData.priority || "medium",
          assignedToId: empId,
          createdById: adminId,
          // NOTE: Status removed from Parent task
          subTasks: {
            create: aiTaskData.subTasks.map(st => ({
              title: st.title,
              description: st.description,
              createdById: empId,
              status: "todo"
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
      aiSummary: aiTaskData.executionSummary
    });
  } catch (error) {
    next(new ApiError(error.statusCode || 500, error.message));
  }
};