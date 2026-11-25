import { CheckCircle2, Layers } from 'lucide-react';
import type { ZernioConnectionSettings } from '../types.ts';

interface ZernioButtonProps {
  zernio?: ZernioConnectionSettings;
  label?: string;
  compact?: boolean;
  onClick: () => void;
}

export function ZernioButton({
  zernio,
  label = 'Connect Zernio',
  compact = false,
  onClick,
}: ZernioButtonProps) {
  const connected = Boolean(zernio?.connected);
  const accounts = zernio?.accounts || [];
  const activeCount = accounts.length;
  const hasTikTok = Boolean(zernio?.hasTikTokAccount);
  const autoOn = Boolean(zernio?.autoUploadEnabled);

  const primaryHandle =
    accounts.length === 1
      ? accounts[0].username || accounts[0].displayName || accounts[0].platform
      : undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-xl border font-semibold transition-colors whitespace-nowrap shrink-0 ${
        connected
          ? 'border-indigo-700/80 bg-indigo-950/50 text-indigo-100 hover:bg-indigo-900/60'
          : 'border-indigo-500/70 bg-indigo-600 text-white hover:bg-indigo-500'
      } ${compact ? 'min-h-[40px] px-3 text-xs' : 'min-h-[44px] px-4 text-sm'}`}
      title={
        connected
          ? `Zernio connected · ${activeCount} account${activeCount === 1 ? '' : 's'}${
              autoOn ? ' · Auto-Upload ON' : ''
            }`
          : 'Sign in with Zernio to sync your connected accounts and auto-upload clips'
      }
    >
      {connected ? (
        <>
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
          <span className="truncate max-w-[175px]">
            {primaryHandle
              ? `Zernio · ${primaryHandle}`
              : `Zernio · ${activeCount} Account${activeCount === 1 ? '' : 's'}${
                  hasTikTok ? ' + TikTok' : ''
                }`}
          </span>
        </>
      ) : (
        <>
          <Layers className="h-3.5 w-3.5 shrink-0" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}
