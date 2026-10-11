import "@fontsource-variable/jost";
import "@fontsource-variable/inter";
import "./styles.css";

import { createRoot } from "react-dom/client";

import { App } from "./App";

const root = createRoot(document.getElementById("root")!);
try {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("Demo configuration is not available.");
  const config = await response.json();
  root.render(<App config={config} />);
} catch {
  root.render(
    <main className="boot-error">
      <h1>The playground could not open</h1>
      <p>Check that the demo server is available, then reload this page.</p>
      <button onClick={() => location.reload()}>Try again</button>
    </main>,
  );
}
