import { Switch } from '@crew/ui';

/** A switch with its label visible beside it. */
export function SwitchRow({ checked, onChange, label, disabled, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  return (
    <div className="flex items-center gap-3 text-[0.8125rem]">
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} testId={testId} />
      <span className="text-fg">{label}</span>
    </div>
  );
}
