import mongoose from 'mongoose';

const { Schema } = mongoose;

const taskSubmissionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    submissionText: { type: String, default: '' },
    isCompleted: { type: Boolean, default: false },
    // 'late' when submitted after the task's dueDate (still accepted, never
    // hard-blocked - mirrors teacher/backend's own Submission lifecycle for
    // bridged assignments).
    status: { type: String, enum: ['on_time', 'late'], default: 'on_time' },
    pointsAwarded: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },

    // Populated only for a bridged task once the teacher actually grades it
    // (see internal.controller.js#gradeBridgedTaskSubmission) - the return
    // leg of the task bridge. null/undefined means "not yet graded", never
    // a fabricated placeholder score.
    teacherScore: { type: Number, default: null },
    teacherMaxScore: { type: Number, default: null },
    teacherFeedback: { type: String, default: null },
    gradedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

taskSubmissionSchema.index({ userId: 1, taskId: 1 }, { unique: true });
// Serves the dashboard's "did this student complete anything that day" probe
// (services/performance.service.js), which filters on userId + isCompleted and
// ranges over completedAt. The unique index above is keyed on taskId, so it
// cannot serve the range; this one does it entirely from the index.
taskSubmissionSchema.index({ userId: 1, isCompleted: 1, completedAt: -1 });

export const TaskSubmission = mongoose.model('TaskSubmission', taskSubmissionSchema);
