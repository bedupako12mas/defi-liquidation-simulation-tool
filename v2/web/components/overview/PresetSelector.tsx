import type { ShockPreset } from "@/lib/api/meta";

export function PresetSelector({
  presets,
  activeId,
  onChange,
}: {
  presets: ShockPreset[];
  activeId: string;
  onChange: (id: ShockPreset["id"]) => void;
}) {
  const active = presets.find((p) => p.id === activeId);
  return (
    <div>
      <div className="pill-group">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="pill"
            data-active={preset.id === activeId}
            onClick={() => onChange(preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </div>
      {active && <p className="preset-note">{active.citation}</p>}
    </div>
  );
}
