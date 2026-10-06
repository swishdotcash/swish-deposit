import "@fontsource-variable/jost";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

import { createRoot } from "react-dom/client";

import { App } from "./App";

const config = await (await fetch("/api/config")).json();
createRoot(document.getElementById("root")!).render(<App config={config} />);
