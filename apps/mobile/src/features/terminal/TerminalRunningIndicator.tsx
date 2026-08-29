import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { StatusPulse } from "../../components/StatusPulse";
import { terminalRunningSessionLabel } from "./terminalRunningStatus";

export function TerminalRunningIndicator(props: {
  readonly sessionCount: number;
  readonly size?: number;
}) {
  const accessibilityLabel = terminalRunningSessionLabel(props.sessionCount);

  if (accessibilityLabel === null) {
    return null;
  }

  return (
    <View accessibilityLabel={accessibilityLabel} accessibilityRole="image">
      <StatusPulse active>
        <SymbolView
          name="terminal"
          size={props.size ?? 13}
          tintColorClassName="accent-terminal-active"
          type="monochrome"
        />
      </StatusPulse>
    </View>
  );
}
