/** The widget's building blocks, drawn to the Paper design. */
import type { ReactNode } from "react";

export const Logo = ({ className = "logo" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 289 148" fill="none" aria-label="Swish" role="img">
    <path
      d="M24.0052 24.0052L60.2824 96.5595C62.1139 100.223 66.9958 101.015 69.8916 98.1189L98.6645 69.346C101.395 66.6152 105.957 67.138 107.999 70.4157L139.349 120.73C141.713 124.524 147.247 124.493 149.569 120.673L180.038 70.5344C182.057 67.2105 186.657 66.6574 189.408 69.4077L218.119 98.1189C221.015 101.015 225.897 100.223 227.728 96.5595L264.005 24.0052"
      stroke="currentColor"
      strokeWidth="48"
      strokeMiterlimit="3.99393"
      strokeLinecap="round"
    />
  </svg>
);

export const WalletIcon = ({ width = 18, height = 13 }: { width?: number; height?: number }) => (
  <svg width={width} height={height} viewBox="0 0 34 24" fill="none" aria-hidden="true">
    <rect x="2" y="2" width="28" height="20" rx="2" stroke="currentColor" strokeWidth="4" />
    <path d="M27 12H32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
  </svg>
);

export const Chevron = () => (
  <svg className="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M3.5 2L6.5 5L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Plus = ({ size = 14, weight = 1.8 }: { size?: number; weight?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
    <path d="M7 2V12M2 7H12" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" />
  </svg>
);

const Lock = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="2.5" y="5.5" width="7" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const FaceId = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9 9.5v1.5M15 9.5v1.5M12 9.5v3.5h-1M9 15.5c.8.7 1.9 1 3 1s2.2-.3 3-1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const Spinner = () => <span className="spinner" aria-hidden="true" />;

export function TopBar({ onClose, locked }: { onClose: () => void; locked: boolean }) {
  return (
    <div className="top">
      <Logo />
      <button className="close" onClick={onClose} disabled={locked} aria-label="Close">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2L10 10M10 2L2 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export const Steps = ({ done }: { done: 1 | 2 | 3 }) => (
  <div className="steps" role="img" aria-label={`Step ${done} of 3`}>
    {[1, 2, 3].map((n) => (
      <i key={n} className={n <= done ? "on" : undefined} />
    ))}
  </div>
);

export function Heading({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div className="heading">
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="title">{title}</h1>
      <p className="lede">{children}</p>
    </div>
  );
}

/** "Deposit to Meridian" over the amount. `lockedBy`: the app fixed the amount. */
export function AmountBlock(props: { app: string; line: string; amount: string; token: string; lockedBy?: string }) {
  return (
    <div className="amount-block">
      <div className="to">
        <span className="app-mark" aria-hidden="true">
          {props.app.charAt(0).toUpperCase()}
        </span>
        <span>{props.line}</span>
        <span className="grow" />
        {props.lockedBy && (
          <span className="locked">
            <Lock />
            Set by {props.lockedBy}
          </span>
        )}
      </div>
      <div className="amount">
        <strong>{props.amount}</strong>
        <span>{props.token}</span>
      </div>
    </div>
  );
}

/** The limit as a bar: already used, this deposit, what stays. */
export function LimitBar({ used = 0, now, rest }: { used?: number; now: number; rest: number }) {
  const part = (value: number, className?: string) =>
    value > 0 ? <i className={className} style={{ flexGrow: value }} /> : null;
  return (
    <div className="bar" aria-hidden="true">
      {part(used, "used")}
      {part(now, "now")}
      {part(rest)}
    </div>
  );
}

/** The main button. `busy` replaces its label with what is being waited for. */
export function Primary(props: { onClick: () => void; busy?: string; disabled?: boolean; faceId?: boolean; children: ReactNode }) {
  const busy = props.busy !== undefined;
  return (
    <button className={busy ? "primary busy" : "primary"} onClick={props.onClick} disabled={busy || props.disabled} aria-busy={busy}>
      {busy ? <Spinner /> : props.faceId ? <FaceId /> : null}
      <span>{busy ? props.busy : props.children}</span>
    </button>
  );
}
