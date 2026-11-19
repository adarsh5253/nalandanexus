import React, { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * The landing page's brand tagline, animated word by word.
 *
 * Built on framer-motion, which this portal already ships and uses in the
 * hero beside it - no new dependency, and the words ride the same
 * transform/opacity pipeline the rest of the hero uses, so the whole sequence
 * stays on the compositor and costs no layout work per frame.
 *
 * Two deliberate performance choices:
 *  - Only `opacity`, `transform` and `background-position` are animated.
 *    Nothing here animates a property that forces layout or paint, so the
 *    sequence cannot contribute to CLS and does not fight the hero's own
 *    entrance animation for main-thread time.
 *  - The loop is a slow, finite-state shimmer rather than a restart of the
 *    whole reveal: the text fades in once, stays legible from then on, and
 *    only the underline and the gradient sheen keep moving. Nothing flashes,
 *    and there is no repeated re-entrance to distract someone reading.
 *
 * `prefers-reduced-motion` (via framer's own `useReducedMotion`) renders the
 * finished state with no animation at all - the tagline is still there, in
 * full, just still.
 */

const WORDS = ["The WORLD's", 'FIRST', 'LEARNING', 'EDUCATION'];

export default function AnimatedTagline({ className = '' }) {
  const shouldReduceMotion = useReducedMotion();

  const container = useMemo(
    () => ({
      hidden: { opacity: 0 },
      visible: {
        opacity: 1,
        transition: {
          delayChildren: 0.15,
          staggerChildren: 0.11,
        },
      },
    }),
    []
  );

  const word = useMemo(
    () => ({
      hidden: { opacity: 0, y: 14, filter: 'blur(6px)' },
      visible: {
        opacity: 1,
        y: 0,
        filter: 'blur(0px)',
        transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
      },
    }),
    []
  );

  // Reduced motion: the finished tagline, no entrance, no shimmer, no underline sweep.
  if (shouldReduceMotion) {
    return (
      <p className={`tagline-static ${className}`}>
        <span className="tagline-text">{WORDS.join(' ')}</span>
      </p>
    );
  }

  return (
    <motion.p
      className={`tagline-wrap ${className}`}
      variants={container}
      initial="hidden"
      animate="visible"
      aria-label={WORDS.join(' ')}
    >
      <span className="tagline-inner">
        {WORDS.map((w) => (
          <motion.span key={w} variants={word} className="tagline-word" aria-hidden="true">
            {w}
          </motion.span>
        ))}

        {/* The underline draws itself once the last word has landed, then
            breathes very slowly. scaleX only - no width animation, so it
            never triggers layout. */}
        <motion.span
          className="tagline-underline"
          aria-hidden="true"
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: [0, 1, 0.55, 1] }}
          transition={{
            scaleX: { duration: 0.9, delay: 0.15 + WORDS.length * 0.11, ease: [0.22, 1, 0.36, 1] },
            opacity: {
              duration: 6,
              delay: 0.15 + WORDS.length * 0.11,
              repeat: Infinity,
              repeatType: 'reverse',
              ease: 'easeInOut',
            },
          }}
        />
      </span>
    </motion.p>
  );
}
