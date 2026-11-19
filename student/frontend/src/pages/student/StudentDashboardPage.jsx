import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useStudent } from '../../context/StudentContext';

// Components
import ReturningHeader from '../../components/student/ReturningHeader';
import FirstLoginHero from '../../components/student/FirstLoginHero';
import ContinueCard from '../../components/student/ContinueCard';
import DueTasks from '../../components/student/DueTasks';
import PerformanceChart from '../../components/student/PerformanceChart';
import LeaderboardSection from '../../components/student/LeaderboardSection';
import ParambhJourney from '../../components/student/ParambhJourney';
import MyEnrollmentCard from '../../components/student/MyEnrollmentCard';
import LearnerProfileCard from '../../components/student/LearnerProfileCard';
import JourneyCard from '../../components/student/JourneyCard';
import ErrorState from '../../components/common/ErrorState';
import { DashboardSkeleton } from '../../components/common/Skeletons';
import { useProgression } from '../../hooks/useProgression';

export default function StudentDashboardPage() {
  const navigate = useNavigate();
  const { student, hasCompletedOnboarding, isLoadingDashboard, dashboardError, refreshData } = useStudent();
  // Refreshes itself when the server reports a progression change, so the card
  // reflects what the backend computed rather than a locally-guessed total.
  const { progression, isLoading: isLoadingProgression } = useProgression();

  // Order matters: a failed load is reported even while a retry is in flight
  // below, but the error is checked first so a request that failed and is not
  // being retried can never read as "still loading".
  if (dashboardError && !student) {
    return (
      <div className="min-h-screen bg-[#EDEAE0] flex items-center justify-center p-4">
        <ErrorState
          title="Unable to load your dashboard"
          error={dashboardError}
          onRetry={refreshData}
        />
      </div>
    );
  }

  // The dashboard's own shape rather than a centred spinner, so the swap to
  // real content does not move anything on the page.
  if (isLoadingDashboard && !student) {
    return <DashboardSkeleton />;
  }

  const isFirstLogin = !hasCompletedOnboarding();

  // If first ever login for this specific student -> Show State A
  if (isFirstLogin) {
    return (
      <div className="min-h-screen bg-[#EDEAE0] flex items-center justify-center p-4">
        <FirstLoginHero onStartParambh={() => navigate('/student/parambh')} />
      </div>
    );
  }

  // State B — Returning Student Dashboard (Default 95% of sessions)
  return (
    <div className="w-full min-h-screen bg-[#EDEAE0] flex flex-col">
      {/* 1. Compact Status Header */}
      <ReturningHeader />

      {/* 2. Main Dashboard Content with Structured Information Hierarchy */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6"
      >
        {/* Section 1: where the learner stands - stage, level, rank, the three
            skill scores, and what the next stage still requires. Placed first
            because it answers "where am I?" before the dashboard asks them to
            do anything. */}
        <LearnerProfileCard data={progression} loading={isLoadingProgression} />

        {/* The three-stage journey. Placed under the profile because "where am
            I in the whole thing" follows naturally from "how am I doing". */}
        <JourneyCard
          journey={progression?.journey || []}
          onContinue={(stage) =>
            // Into the stage the student is actually on, not always PRARAMBH.
            navigate(stage?.course?.slug ? `/student/course/${stage.course.slug}` : '/student/parambh')
          }
        />

        {/* Section 2: Continue where you left off */}
        <ContinueCard />

        {/* Section 2: Due today / this week */}
        <DueTasks />

        {/* Grid for Section 3 (Performance) & Section 4 (Leaderboard/Motivation) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Section 3: Your Performance (7 cols on desktop) */}
          <div className="lg:col-span-7">
            <PerformanceChart />
          </div>

          {/* Section 4: Leaderboard / motivation (5 cols on desktop) */}
          <div className="lg:col-span-5">
            <LeaderboardSection />
          </div>
        </div>

        {/* Section 5: Parambh Journey */}
        <ParambhJourney />

        {/* Section 6: the student's own enrollment identity, batch and teacher —
            all of which existed in the data and appeared on no screen. */}
        <MyEnrollmentCard />
      </motion.div>
    </div>
  );
}
