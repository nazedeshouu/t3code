import { NAZE_LABS, nazeLabEnabled } from "../../nazeLabs";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NazeStuffSection() {
  return (
    <SettingsSection id="naze-stuff" title="Naze's stuff">
      {NAZE_LABS.map((lab) => (
        <NazeLabRow key={lab.id} lab={lab} />
      ))}
    </SettingsSection>
  );
}

function NazeLabRow({ lab }: { lab: (typeof NAZE_LABS)[number] }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting(lab.id)}
      description={lab.description}
      control={
        <Switch
          checked={nazeLabEnabled(settings, lab.id)}
          onCheckedChange={(checked) =>
            updateSettings({ nazeLabs: { ...settings.nazeLabs, [lab.id]: Boolean(checked) } })
          }
          aria-label={lab.title}
        />
      }
    />
  );
}
