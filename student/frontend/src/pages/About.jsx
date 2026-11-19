import React from 'react';
import {
  Sparkles,
  Globe,
  Cpu,
  Palette,
  Users,
  BookOpen,
  ShieldCheck,
  Mail,
  Phone,
  MapPin,
  CheckCircle2,
  Award,
} from 'lucide-react';
import { companyContacts } from '../data/network';
import FacultyTabs from '../components/about/FacultyTabs';

export default function About() {
  return (
    <div className="min-h-screen pt-28 pb-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="text-center max-w-3xl mx-auto mb-16">
        <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-700 dark:text-purple-300 text-xs font-semibold mb-4">
          <Sparkles className="w-3.5 h-3.5" />
          <span>OUR HERITAGE &amp; MISSION</span>
        </div>
        <h1 className="font-heading font-extrabold text-4xl sm:text-5xl lg:text-6xl text-slate-900 dark:text-white tracking-tight leading-tight">
          Reinventing Ancient Wisdom for the Digital Future
        </h1>
        <p className="text-base sm:text-lg text-slate-600 dark:text-slate-300 mt-4 leading-relaxed font-medium">
          Over 1,500 years ago, Nalanda University stood as the beacon of global residential knowledge. Nalanda Nexus transforms this timeless legacy into a 21st-century digital ecosystem.
        </p>
      </div>

      {/* Story Narrative Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-20">
        <div className="p-8 rounded-3xl bg-white/95 dark:bg-[#0D1424]/80 backdrop-blur-xl border border-slate-200/90 dark:border-white/15 shadow-xl shadow-slate-200/50 dark:shadow-2xl space-y-4">
          <h3 className="font-heading font-bold text-2xl text-slate-900 dark:text-white">
            The Historical Nalanda Spirit
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
            Ancient Nalanda was renowned not for rote memorization, but for rigorous open debate, interdisciplinary research, and deep community living. Scholars from China, Korea, Japan, Persia, and Greece traveled thousands of miles to exchange profound ideas.
          </p>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
            In our world of hyper-specialization and fragmented courses, modern students often lack this holistic synthesis. Nalanda Nexus re-establishes the interdisciplinary hearth.
          </p>
        </div>

        <div className="p-8 rounded-3xl bg-white/95 dark:bg-[#0D1424]/80 backdrop-blur-xl border border-slate-200/90 dark:border-white/15 shadow-xl shadow-slate-200/50 dark:shadow-2xl space-y-4">
          <h3 className="font-heading font-bold text-2xl text-slate-900 dark:text-white">
            The 3 Pillars of Modern Mastery
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
            To thrive today, every engineer, designer, and scholar must command three interconnected faculties:
          </p>
          <ul className="space-y-2 text-xs sm:text-sm text-slate-700 dark:text-slate-300 font-medium">
            <li className="flex items-start gap-2">
              <span className="text-purple-700 dark:text-purple-400 font-bold">1. COMMUNICATE:</span>
              <span>Express nuanced arguments, collaborate across virtual teams, and lead with empathy.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-cyan-700 dark:text-cyan-400 font-bold">2. COMPUTE:</span>
              <span>Harness algorithmic thinking, cloud infrastructure, and generative AI models.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-orange-700 dark:text-orange-400 font-bold">3. CREATE:</span>
              <span>Transform abstract knowledge into physical and digital artifacts that serve humanity.</span>
            </li>
          </ul>
        </div>
      </div>

      {/* Nalanda Nexus Network (Leadership & Mentors) */}
      <div className="mb-20">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-700 dark:text-cyan-300 text-xs font-semibold mb-3">
            <Users className="w-3.5 h-3.5" />
            <span>EXPERT LEADERSHIP &amp; FACULTY</span>
          </div>
          <h2 className="font-heading font-extrabold text-3xl sm:text-4xl text-slate-900 dark:text-white tracking-tight">
            Nalanda Nexus Network
          </h2>
          <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 mt-2 font-medium">
            Meet the mentors and experts associated with Nalanda Nexus.
          </p>
        </div>

        <FacultyTabs />
      </div>

      {/* Core Principles Grid */}
      <div className="mb-20">
        <h2 className="font-heading font-extrabold text-3xl text-slate-900 dark:text-white text-center mb-10">
          Our Guiding Principles
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <div className="p-6 rounded-3xl bg-white/95 dark:bg-[#0D1424]/80 border border-purple-300 dark:border-purple-500/30 text-center space-y-3 shadow-lg shadow-purple-900/5">
            <div className="w-12 h-12 rounded-2xl bg-purple-500/20 text-purple-700 dark:text-purple-300 flex items-center justify-center mx-auto">
              <Globe className="w-6 h-6" />
            </div>
            <h4 className="font-heading font-bold text-lg text-slate-900 dark:text-white">Open to the World</h4>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
              Democratizing high-caliber computer science, AI, and communication education regardless of geography or background.
            </p>
          </div>

          <div className="p-6 rounded-3xl bg-white/95 dark:bg-[#0D1424]/80 border border-cyan-300 dark:border-cyan-500/30 text-center space-y-3 shadow-lg shadow-cyan-900/5">
            <div className="w-12 h-12 rounded-2xl bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 flex items-center justify-center mx-auto">
              <Cpu className="w-6 h-6" />
            </div>
            <h4 className="font-heading font-bold text-lg text-slate-900 dark:text-white">Hands-on Sandbox</h4>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
              Theory backed by immediate live computation, automated test suites, and production code reviews.
            </p>
          </div>

          <div className="p-6 rounded-3xl bg-white/95 dark:bg-[#0D1424]/80 border border-orange-300 dark:border-orange-500/30 text-center space-y-3 shadow-lg shadow-orange-900/5">
            <div className="w-12 h-12 rounded-2xl bg-orange-500/20 text-orange-700 dark:text-orange-300 flex items-center justify-center mx-auto">
              <Users className="w-6 h-6" />
            </div>
            <h4 className="font-heading font-bold text-lg text-slate-900 dark:text-white">Lifelong Cohorts</h4>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
              You do not graduate out of Nalanda Nexus—you step into an active alumni guild of innovators and mentors.
            </p>
          </div>
        </div>
      </div>

      {/* Official Company Contact Section */}
      <div id="contact" className="p-8 sm:p-12 rounded-3xl bg-white/95 dark:bg-[#0D1424]/90 border border-slate-200/90 dark:border-white/15 shadow-xl shadow-slate-200/50 dark:shadow-2xl text-center max-w-3xl mx-auto">
        <h3 className="font-heading font-bold text-2xl text-slate-900 dark:text-white mb-2">
          Get in Touch with Nalanda Nexus
        </h3>
        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mb-8 font-medium">
          Have admissions inquiries, institutional collaborations, or mentor questions? Reach out to our official team directly.
        </p>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs sm:text-sm text-slate-700 dark:text-slate-300 font-medium text-left">
          <a
            href={`mailto:${companyContacts.email}`}
            className="flex items-center gap-3 p-4 rounded-2xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 hover:border-cyan-500 transition-colors"
          >
            <div className="w-9 h-9 rounded-xl bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 flex items-center justify-center shrink-0">
              <Mail className="w-4 h-4" />
            </div>
            <div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 block uppercase font-semibold">Official Email</span>
              <span className="font-semibold text-slate-900 dark:text-white text-xs sm:text-sm">{companyContacts.email}</span>
            </div>
          </a>

          <a
            href="tel:+918630996363"
            className="flex items-center gap-3 p-4 rounded-2xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 hover:border-purple-500 transition-colors"
          >
            <div className="w-9 h-9 rounded-xl bg-purple-500/15 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
              <Phone className="w-4 h-4" />
            </div>
            <div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 block uppercase font-semibold">Helpline Numbers</span>
              <span className="font-semibold text-slate-900 dark:text-white text-xs sm:text-sm">{companyContacts.primaryPhone} / {companyContacts.secondaryPhone}</span>
            </div>
          </a>
        </div>
      </div>
    </div>
  );
}
