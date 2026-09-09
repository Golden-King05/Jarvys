import React from "react";
import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";

interface RingChartProps {
  size?: number;
  strokeWidth?: number;
  outerPercent: number;
  outerColor: string;
  innerPercent: number;
  innerColor: string;
  trackColor?: string;
}

// Two concentric progress rings sharing one center — outer ring for context
// usage, inner ring for daily message usage (see HomeScreen). Both start
// their fill at 12 o'clock via the -90deg rotation.
export default function RingChart({
  size = 160,
  strokeWidth = 14,
  outerPercent,
  outerColor,
  innerPercent,
  innerColor,
  trackColor = "#eee",
}: RingChartProps) {
  const center = size / 2;
  const gap = 6;
  const outerRadius = center - strokeWidth / 2;
  const innerRadius = outerRadius - strokeWidth - gap;

  const outerCircumference = 2 * Math.PI * outerRadius;
  const innerCircumference = 2 * Math.PI * innerRadius;

  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  const outerOffset = outerCircumference * (1 - clamp(outerPercent) / 100);
  const innerOffset = innerCircumference * (1 - clamp(innerPercent) / 100);

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle cx={center} cy={center} r={outerRadius} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
        <Circle
          cx={center}
          cy={center}
          r={outerRadius}
          stroke={outerColor}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={`${outerCircumference} ${outerCircumference}`}
          strokeDashoffset={outerOffset}
          strokeLinecap="round"
          rotation={-90}
          origin={`${center}, ${center}`}
        />
        <Circle cx={center} cy={center} r={innerRadius} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
        <Circle
          cx={center}
          cy={center}
          r={innerRadius}
          stroke={innerColor}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={`${innerCircumference} ${innerCircumference}`}
          strokeDashoffset={innerOffset}
          strokeLinecap="round"
          rotation={-90}
          origin={`${center}, ${center}`}
        />
      </Svg>
    </View>
  );
}
