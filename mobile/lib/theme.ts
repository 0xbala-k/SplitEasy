// Design tokens for SplitEasy — sourced from ui-ux-pro-max design system
export const Colors = {
  primary: '#2563EB',
  primaryLight: '#DBEAFE',
  primaryDark: '#1D4ED8',
  primaryMuted: '#EFF6FF',

  success: '#10B981',
  successLight: '#D1FAE5',
  warning: '#F59E0B',
  warningLight: '#FEF3C7',
  error: '#EF4444',
  errorLight: '#FEE2E2',

  bg: '#F8FAFC',
  surface: '#FFFFFF',
  surfaceMuted: '#F1F5F9',

  textPrimary: '#0F172A',
  textSecondary: '#64748B',
  textTertiary: '#94A3B8',
  textInverse: '#FFFFFF',

  border: '#E2E8F0',
  divider: '#F1F5F9',

  hero: '#1E3A5F',

  tabActive: '#2563EB',
  tabInactive: '#94A3B8',
};

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  full: 999,
};

export const Shadow = {
  sm: {
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  md: {
    shadowColor: '#0F172A',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

// Spending buckets. The three `wants` buckets share the amber family so the
// group still reads as one wedge when the donut is drilled in, while Travel,
// Needs, and Misc stay clearly distinct from them and from each other.
export const BucketColors = {
  travel: '#0EA5E9',
  needs: '#2563EB',
  food: '#F59E0B',
  shopping: '#FB923C',
  experiences: '#FCD34D',
  misc: '#94A3B8',
};

export const GroupColors = {
  travel: '#0EA5E9',
  needs: '#2563EB',
  wants: '#F59E0B',
  misc: '#94A3B8',
};

// Merchant avatar colors — assigned by first char code mod
const AVATAR_PALETTE = [
  '#2563EB', '#7C3AED', '#DB2777', '#EA580C',
  '#16A34A', '#0891B2', '#CA8A04', '#DC2626',
];
export function merchantColor(name: string): string {
  const code = (name.charCodeAt(0) || 0) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[code];
}
