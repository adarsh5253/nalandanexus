# Nalanda Nexus Platform

An integrated educational ecosystem consisting of three dedicated portals, each organized with separate `frontend` and `backend` services:

---

## Architecture Overview

```
Nalanda/
├── student/
│   ├── frontend/             # Complete Student Web Application (React + Vite + Tailwind)
│   │   ├── src/              # Parambh, Quizzes, Notes, Live Classes, Character Auth
│   │   ├── public/           # Multimedia assets, video, diagrams
│   │   ├── package.json
│   │   └── vite.config.js    # Runs on Port 5173
│   └── backend/              # Student API Service (Node / Express)
│       ├── src/              # Auth, student profiles, courses, tasks routes
│       └── package.json      # Runs on Port 5001
│
├── teacher/
│   ├── frontend/             # Faculty & Instructor Portal (React + Vite + Tailwind)
│   │   ├── src/              # Courses, Assignment Grading, Live Studio, Cohort Analytics
│   │   ├── package.json
│   │   └── vite.config.js    # Runs on Port 5174
│   └── backend/              # Teacher API Service (Node / Express)
│       ├── src/              # Submissions, evaluation, scheduling routes
│       └── package.json      # Runs on Port 5002
│
└── admin/
    ├── frontend/             # Master Institutional Admin Portal (React + Vite + Tailwind)
    │   ├── src/              # User provisioning, Course Governance, Telemetry & Logs
    │   ├── package.json
    │   └── vite.config.js    # Runs on Port 5175
    └── backend/              # Master Admin API Service (Node / Express)
        ├── src/              # Audit logs, role controls, system health routes
        └── package.json      # Runs on Port 5003
```

---

## Port Allocation

| Portal | Frontend Port | Backend API Port |
| :--- | :--- | :--- |
| **Student** | `http://localhost:5173` | `http://localhost:5001` |
| **Teacher** | `http://localhost:5174` | `http://localhost:5002` |
| **Admin** | `http://localhost:5175` | `http://localhost:5003` |

---

## Running the Applications

### 1. Student Portal
```bash
# Frontend
cd student/frontend
npm run dev

# Backend
cd student/backend
npm install
npm run dev
```

### 2. Teacher Portal
```bash
# Frontend
cd teacher/frontend
npm install
npm run dev

# Backend
cd teacher/backend
npm install
npm run dev
```

### 3. Admin Portal
```bash
# Frontend
cd admin/frontend
npm install
npm run dev

# Backend
cd admin/backend
npm install
npm run dev
```

---

## Onboarding a teacher

An administrator creates a teacher in **Admin → Teachers → Create Teacher**.

| | |
| :--- | :--- |
| **Required** | Full name, email, subject *or* department, and at least one course (PRARAMBH / GARUD / YODDHA — read live from the student catalogue) |
| **Optional** | Mobile number, designation, profile photo |
| **Generated** | Teacher ID (`TCH-0001`, also accepted as the username at login). No password is generated for anyone to see or share. |

The teacher is emailed a **single-use, time-limited link** (72 hours by default) to choose their own password at the Teacher Portal's `/setup-password` page. No password is ever emailed or returned by an API. Admin shows whether the email was accepted by the provider (and, if not, the provider's own reason), and **Resend setup email** issues a new link and kills the old one.

**Course-wise visibility.** A teacher sees every student enrolled in each course assigned to them — and only those — under *Courses → View students*. It updates by itself: the student portal already sends a student's record after every purchase, coupon, free enrolment and profile edit, and the teacher portal applies it as it arrives. Assigning a course loads the students already enrolled. Grades, attendance and progress stay with the batch's own teacher; the course roster is read-only.

Settings (all optional except the email key):

| Service | Variable | Purpose |
| :--- | :--- | :--- |
| admin | `SENDGRID_API_KEY` | Without it no email is sent (status shows *Email not configured*). |
| admin | `SMTP_FROM` | Must be a **verified sender** in SendGrid, or every send is rejected (403). |
| admin | `TEACHER_PORTAL_URL` | Leave unset: the Teacher service reports its own `CLIENT_URL`. Override only for a custom domain. |
| admin | `TEACHER_SETUP_LINK_TTL_HOURS` | Link lifetime, 1–168 (default 72). |
| teacher | `CLIENT_URL` | Must be the address the Teacher Portal frontend is served from — the email links there. |

**Deploy order:** student → teacher → admin. The teacher service still accepts the older temporary-password provisioning, so an Admin that has not been updated yet keeps working while the others roll out.
