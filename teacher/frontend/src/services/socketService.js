import { io } from 'socket.io-client';

// The socket server is the API's own origin. VITE_SOCKET_URL still wins when
// set, but a deployment that sets only VITE_TEACHER_API_URL no longer leaves
// every live update pointed at localhost (the student portal derives its
// socket the same way).
const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.VITE_TEACHER_API_URL || 'http://localhost:5002/api/teacher').replace(/\/api(\/teacher)?\/?$/, '');

class SocketService {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    // The last connection status, replayed to anyone who subscribes later. The
    // socket is opened during the session check, before the layout mounts, so
    // its 'connect' usually fires before the "Live" badge is listening - which
    // left the badge on "Reconnecting..." while the socket was connected.
    this.lastStatus = null;
    this.listeners = new Map();
    // classId -> subscriber count. Multiple independent hooks (e.g. the
    // dashboard's "stay subscribed to all my classes" and the leaderboard's
    // "subscribe to just the selected class") can both be interested in the
    // same class room at once. A plain Set can't tell "still wanted by
    // someone else" from "nobody wants this anymore", so one consumer
    // unsubscribing would silently kill the room for every other consumer.
    this.subscribedClasses = new Map();
  }

  connect() {
    if (this.socket) return this.socket;

    try {
      this.socket = io(SOCKET_URL, {
        // Required so the browser attaches the httpOnly session cookie to
        // the handshake — the frontend and backend are different origins
        // (different ports) in development, so without this the socket
        // connects but never authenticates, and teacher-scoped events like
        // notification.created would silently never arrive.
        withCredentials: true,
        autoConnect: true,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
        timeout: 8000,
      });

      this.socket.on('connect', () => {
        this.isConnected = true;
        this.emitStatusChange('connected');
        // Resubscribe to every class room still wanted by someone.
        this.subscribedClasses.forEach((_count, classId) => {
          this.socket.emit('subscribe:class', { classId });
        });
      });

      this.socket.on('disconnect', (reason) => {
        this.isConnected = false;
        this.emitStatusChange('disconnected', reason);
      });

      this.socket.on('connect_error', () => {
        this.isConnected = false;
        this.emitStatusChange('reconnecting');
      });

      // Forward native socket events to registered listeners. This list must
      // match exactly what the backend actually emits (see
      // backend/src/sockets/index.js#emitToTeacher/emitToClass call sites:
      // submission.service.js, notification.service.js, message.service.js,
      // announcement.service.js) — an event name here that the server never
      // sends is dead weight, and one the server sends that's missing here
      // silently never arrives.
      const forwardEvents = [
        'score:update',
        'submission.received',
        'notification.created',
        'message.created',
        'announcement:published',
        'announcement:updated',
        'announcement:expired',
        'announcement:deleted',
        'announcement:admin',
        'announcement:admin_removed',
        'course.assigned',
        'course.unassigned',
        // An administrator added or removed a catalogue course (PRARAMBH, GARUD,
        // YODDHA) for this teacher - courseRoster.service.js#setTeacherCourses.
        'course.access_changed',
        // Students enrolled in (or left) a course this teacher has - a purchase,
        // a coupon, a profile edit or a refund reached the student portal and was
        // applied here. courseRoster.service.js.
        'course.roster_updated',
        'class.rescheduled',
        'class.started',
        'class.completed',
        'class.cancelled',
        'class.updated',
        // A student's record arrived from the student portal - an enrolment or a
        // profile change for someone on this teacher's roster.
        'student.synced',
      ];
      forwardEvents.forEach((ev) => {
        this.socket.on(ev, (payload) => {
          this.dispatch(ev, payload);
        });
      });
    } catch {
      this.emitStatusChange('disconnected');
    }

    return this.socket;
  }

  subscribeToClass(classId) {
    if (!classId) return;
    const key = String(classId);
    const count = this.subscribedClasses.get(key) || 0;
    this.subscribedClasses.set(key, count + 1);
    // Idempotent server-side (a repeat socket.join is a no-op), so it's safe
    // to emit on every call rather than only the first subscriber.
    if (this.socket && this.isConnected) {
      this.socket.emit('subscribe:class', { classId });
    }
  }

  unsubscribeFromClass(classId) {
    if (!classId) return;
    const key = String(classId);
    const count = this.subscribedClasses.get(key) || 0;
    if (count <= 1) {
      this.subscribedClasses.delete(key);
      if (this.socket && this.isConnected) {
        this.socket.emit('unsubscribe:class', { classId });
      }
    } else {
      this.subscribedClasses.set(key, count - 1);
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    if (event === 'connection:status' && this.lastStatus) {
      const replay = this.lastStatus;
      // Delivered asynchronously, like a real status change, and only if the
      // subscriber is still there by then.
      queueMicrotask(() => {
        if (this.listeners.get(event)?.has(callback)) callback(replay);
      });
    }

    // Return cleanup function
    return () => {
      this.off(event, callback);
    };
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  dispatch(event, payload) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach((cb) => {
        try {
          cb(payload);
        } catch (err) {
          console.error(`Error in socket listener for ${event}:`, err);
        }
      });
    }
  }

  emitStatusChange(status, detail = null) {
    this.lastStatus = { status, isConnected: this.isConnected, detail };
    this.dispatch('connection:status', this.lastStatus);
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
    }
    this.lastStatus = null;
    this.listeners.clear();
  }
}

export const socketService = new SocketService();
export default socketService;
