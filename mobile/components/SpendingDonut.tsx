import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { Colors, Spacing } from '@/lib/theme';

export interface SliceInput {
  key: string;
  label: string;
  cents: number;
  color: string;
}

export interface Slice extends SliceInput {
  startAngle: number;
  endAngle: number;
  fraction: number;
  path: string;
}

const SIZE = 220;
const STROKE = 34;

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  // -90 so angle 0 starts at 12 o'clock rather than 3 o'clock.
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function donutSegment(
  cx: number, cy: number, rOuter: number, rInner: number,
  start: number, end: number
): string {
  const largeArc = end - start > 180 ? 1 : 0;
  const o1 = polar(cx, cy, rOuter, start);
  const o2 = polar(cx, cy, rOuter, end);
  const i2 = polar(cx, cy, rInner, end);
  const i1 = polar(cx, cy, rInner, start);
  return [
    `M ${o1.x} ${o1.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${o2.x} ${o2.y}`,
    `L ${i2.x} ${i2.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${i1.x} ${i1.y}`,
    'Z',
  ].join(' ');
}

/**
 * Cents → arc geometry. Zero-value slices are dropped rather than drawn, since
 * a zero-width arc renders as a visible hairline seam.
 */
export function computeSlices(inputs: SliceInput[]): Slice[] {
  const present = inputs.filter((s) => s.cents > 0);
  const total = present.reduce((sum, s) => sum + s.cents, 0);
  if (total === 0) return [];

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const rOuter = SIZE / 2;
  const rInner = rOuter - STROKE;

  let angle = 0;
  return present.map((s) => {
    const fraction = s.cents / total;
    const startAngle = angle;
    const endAngle = angle + fraction * 360;
    angle = endAngle;
    return {
      ...s,
      fraction,
      startAngle,
      endAngle,
      path: donutSegment(cx, cy, rOuter, rInner, startAngle, endAngle),
    };
  });
}

/**
 * A slice with real spending can still round to 0% (e.g. a $0.01 slice in a
 * $1,000 month). Announcing "0%" there is indistinguishable from the
 * genuinely-empty state, so floor it to "less than 1%" instead.
 */
function spendingShareLabel(fraction: number): string {
  const rounded = Math.round(fraction * 100);
  if (fraction > 0 && rounded === 0) return 'less than 1% of spending';
  return `${rounded}% of spending`;
}

interface Props {
  slices: SliceInput[];
  centerLabel: string;
  centerCaption: string;
  onSlicePress?: (key: string) => void;
  size?: number;
}

export default function SpendingDonut({
  slices, centerLabel, centerCaption, onSlicePress, size = SIZE,
}: Props) {
  const computed = computeSlices(slices);
  const cx = SIZE / 2;
  const rMid = SIZE / 2 - STROKE / 2;

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {computed.length === 0 ? (
          <Circle
            cx={cx} cy={cx} r={rMid}
            stroke={Colors.surfaceMuted} strokeWidth={STROKE} fill="none"
          />
        ) : computed.length === 1 ? (
          // A single slice spans the full circle, where start and end angles
          // coincide and the arc path degenerates. Draw a plain ring instead.
          <Circle
            cx={cx} cy={cx} r={rMid}
            stroke={computed[0].color} strokeWidth={STROKE} fill="none"
          />
        ) : (
          <G>
            {computed.map((s) => (
              <Path key={s.key} d={s.path} fill={s.color} />
            ))}
          </G>
        )}
      </Svg>

      <View style={styles.center} pointerEvents="none">
        <Text style={styles.centerLabel} numberOfLines={1} adjustsFontSizeToFit>
          {centerLabel}
        </Text>
        <Text style={styles.centerCaption} numberOfLines={1}>{centerCaption}</Text>
      </View>

      {/*
        Touch targets live outside the SVG. react-native-svg's press handling
        differs between native and react-native-web, and this app ships as a
        PWA — a row of plain Pressables behaves identically on both, and gives
        screen readers a real, labelled control per slice.
      */}
      <View style={styles.hitRow} accessibilityRole="tablist">
        {computed.length === 0 ? (
          <View accessible accessibilityLabel="No spending this month" />
        ) : (
          computed.map((s) => (
            <Pressable
              key={s.key}
              style={[styles.hit, { backgroundColor: s.color, flex: s.fraction }]}
              onPress={() => onSlicePress?.(s.key)}
              accessibilityRole="button"
              accessibilityLabel={`${s.label}, ${spendingShareLabel(s.fraction)}`}
            />
          ))
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'center', justifyContent: 'center', alignItems: 'center' },
  center: { position: 'absolute', alignItems: 'center', paddingHorizontal: Spacing.lg },
  centerLabel: { fontSize: 26, fontWeight: '700', color: Colors.textPrimary },
  centerCaption: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  hitRow: {
    position: 'absolute',
    bottom: -Spacing.md,
    flexDirection: 'row',
    width: '100%',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  // flexBasis 0 with an explicit flex-grow keeps RN-web from sizing these by
  // content; see the min-width:auto note in the global constraints.
  hit: { flexBasis: 0, minWidth: 2 },
});
