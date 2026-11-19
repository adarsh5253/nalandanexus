import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Play, Star } from 'lucide-react';
import HeroVisual from './HeroVisual';
import PrarambhModal from './PrarambhModal';
import AnimatedTagline from '../brand/AnimatedTagline';
import { playTone } from '../../utils/sound';

export default function Hero() {
  const [isPrarambhOpen, setIsPrarambhOpen] = useState(false);

  const handlePrarambhClick = () => {
    playTone(580, 'triangle', 0.1, 0.05);
    setIsPrarambhOpen(true);
  };

  return (
    <section className="relative pt-28 pb-14 sm:pt-32 sm:pb-16 lg:pt-36 lg:pb-20 overflow-hidden">
      {/* Ambient Radial Lights */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] sm:w-[900px] h-[500px] bg-gradient-to-b from-purple-600/10 via-cyan-500/10 to-transparent blur-[140px] pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-8 items-center">
          
          {/* LEFT: Hero Copy & Actions */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
            className="lg:col-span-6 flex flex-col items-start text-left"
          >
            {/* Top Badge matching template image */}
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-100/90 dark:bg-[#0D1424]/90 border border-purple-500/30 backdrop-blur-md shadow-md dark:shadow-lg dark:shadow-purple-950/20 mb-6 group hover:border-purple-400/60 transition-colors">
              <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
              <span className="text-xs sm:text-[13px] font-semibold text-slate-800 dark:text-slate-200 tracking-wide">
                Empowering the Digital Generation
              </span>
            </div>

            {/* Brand tagline — animated word by word, sits between the badge
                and the H1 so it reads as a kicker to the headline rather than
                competing with it. */}
            <AnimatedTagline className="mb-5" />

            {/* Giant Heading matching exact template */}
            <h1 className="font-heading font-extrabold text-5xl sm:text-6xl md:text-7xl lg:text-[78px] tracking-tight leading-[1.06] mb-6">
              <span className="block text-slate-900 dark:text-white">Learn.</span>
              <span className="block bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-700 dark:from-[#A855F7] dark:via-[#C084FC] dark:to-[#9333EA] bg-clip-text text-transparent">
                Create.
              </span>
              <span className="block bg-gradient-to-r from-cyan-600 via-sky-600 to-blue-600 dark:from-[#38BDF8] dark:via-[#06B6D4] dark:to-[#2563EB] bg-clip-text text-transparent">
                Connect.
              </span>
            </h1>

            {/* Supporting Subtitle */}
            <p className="text-base sm:text-lg text-slate-600 dark:text-slate-300 max-w-xl leading-relaxed mb-8 sm:mb-10 font-normal">
              Nalanda Nexus is a next-gen learning ecosystem that empowers you to communicate, compute and create for a better tomorrow.
            </p>

            {/* CTA Actions */}
            <div className="flex flex-wrap items-center gap-4 sm:gap-6 w-full sm:w-auto">
              {/* Primary CTA */}
              <Link
                to="/signup"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-full text-sm sm:text-base font-semibold text-white bg-gradient-to-r from-purple-600 via-indigo-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 shadow-xl shadow-purple-600/25 hover:shadow-purple-600/40 hover:scale-105 active:scale-95 transition-all"
              >
                <span>Start Your Journey</span>
                <ArrowRight className="w-4 h-4" />
              </Link>

              {/* Secondary CTA: Watch PRARAMBH */}
              <button
                onClick={handlePrarambhClick}
                className="w-full sm:w-auto inline-flex items-center gap-3 px-5 py-3 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10 border border-slate-300 dark:border-white/15 hover:border-cyan-500 backdrop-blur-md text-slate-900 dark:text-white transition-all group hover:scale-105 shadow-sm"
              >
                <div className="w-9 h-9 rounded-full bg-white dark:bg-[#0D1424] border border-cyan-500/40 flex items-center justify-center text-cyan-600 dark:text-cyan-400 shadow-md group-hover:bg-cyan-500 group-hover:text-white dark:group-hover:text-slate-950 transition-colors">
                  <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                </div>
                <div className="text-left">
                  <span className="block text-xs sm:text-sm font-semibold tracking-wide text-slate-900 dark:text-white group-hover:text-cyan-600 dark:group-hover:text-cyan-300">
                    Watch PRARAMBH
                  </span>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400 -mt-0.5">
                    Our Story
                  </span>
                </div>
              </button>
            </div>
          </motion.div>

          {/* RIGHT: Hero Visual & Interactive Floating Cards */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.2, ease: 'easeOut' }}
            className="lg:col-span-6 relative"
          >
            <HeroVisual />
          </motion.div>

        </div>
      </div>

      {/* PRARAMBH Video Modal */}
      <PrarambhModal
        isOpen={isPrarambhOpen}
        onClose={() => setIsPrarambhOpen(false)}
      />
    </section>
  );
}
