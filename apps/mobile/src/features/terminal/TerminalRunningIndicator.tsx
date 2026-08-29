import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

const sharedPulseOpacity = makeMutable(1);
let pulseSubscriberCount = 0;

function subscribeToPulse() {
  pulseSubscriberCount += 1;
  if (pulseSubscriberCount === 1) {
    sharedPulseOpacity.value = withRepeat(
      withTiming(0.35, { duration: 800, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }

  return () => {
    pulseSubscriberCount = Math.max(0, pulseSubscriberCount - 1);
    if (pulseSubscriberCount === 0) {
      cancelAnimation(sharedPulseOpacity);
      sharedPulseOpacity.value = 1;
    }
  };
}

export function TerminalRunningIndicator() {
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) {
      return;
    }
    return subscribeToPulse();
  }, [reduceMotion]);

  const animatedStyle = useAnimatedStyle(
    () => ({ opacity: reduceMotion ? 1 : sharedPulseOpacity.value }),
    [reduceMotion],
  );

  return (
    <Animated.View
      accessibilityLabel="Terminal process running"
      accessibilityRole="image"
      className="h-[6px] w-[6px] rounded-full bg-green-500"
      style={animatedStyle}
    />
  );
}
