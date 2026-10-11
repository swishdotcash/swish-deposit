import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Primary, Spinner } from "./widget/ui";

export function DeviceButton({
  initial,
  disabled,
  onClick,
}: {
  initial?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button className="device-button" onClick={onClick} disabled={disabled}>
      <span className="device-icon">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span>
        <strong>
          {initial
            ? "Already set up? Try your phone."
            : "Try on another device"}
        </strong>
        <small>{initial ? "Show QR code" : "Scan QR or copy link"}</small>
      </span>
      <span aria-hidden="true">→</span>
    </button>
  );
}

export function QrCard({
  url,
  onBack,
  error,
  loading,
}: {
  url: string | null;
  onBack(): void;
  error?: string;
  loading?: boolean;
}) {
  const [image, setImage] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [qrError, setQrError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    setCopied(false);
    setImage("");
    setQrError("");
    if (url)
      void QRCode.toDataURL(url, {
        width: 400,
        margin: 4,
        errorCorrectionLevel: "M",
        color: { dark: "#121212", light: "#ffffff" },
      })
        .then((src) => {
          if (live) setImage(src);
        })
        .catch(() => {
          if (live)
            setQrError(
              "The QR code could not be created. Use Copy link instead.",
            );
        });
    return () => {
      live = false;
    };
  }, [url]);
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError("Copy this link to open it on another device.");
      requestAnimationFrame(() => input.current?.select());
    }
  }
  const local =
    url && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);
  return (
    <div className="card qr-card">
      <div className="qr-heading">
        <h2>Continue on another device</h2>
        <p>Scan with your phone camera, or copy the link to another browser.</p>
      </div>
      <div className="qr-code">
        {image ? (
          <img
            src={image}
            width="200"
            height="200"
            alt="QR code for this deposit"
          />
        ) : qrError ? (
          <p className="note">{qrError}</p>
        ) : (
          <Spinner />
        )}
      </div>
      {url && <p className="qr-domain">{new URL(url).host}</p>}
      <Primary
        onClick={() => void copy()}
        disabled={!url}
        busy={loading ? "Creating link" : undefined}
      >
        {copied ? "Link copied" : "Copy link"}
      </Primary>
      <p className="sr-only" role="status">
        {copied ? "Deposit link copied" : ""}
      </p>
      {copyError && (
        <>
          <p className="note">{copyError}</p>
          <input
            ref={input}
            readOnly
            value={url ?? ""}
            aria-label="Deposit link"
            className="copy-field"
          />
        </>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
      {local && (
        <p className="fine">
          This local link works on this computer. For another device, open the
          demo at its shared HTTPS address.
        </p>
      )}
      <button className="back-link" onClick={onBack}>
        Continue on this device
      </button>
    </div>
  );
}
