import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { StatusPulse } from "../../components/StatusPulse";
import { TERMINAL_RUNNING_ACCESSIBILITY_LABEL } from "./terminalRunningStatus";

export function TerminalRunningIndicator(props: { readonly size?: number }) {
  return (
    <View accessibilityLabel={TERMINAL_RUNNING_ACCESSIBILITY_LABEL} accessibilityRole="image">
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
