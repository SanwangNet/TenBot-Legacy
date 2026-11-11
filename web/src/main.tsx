import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StardustApp } from "./stardust-app.js";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<StrictMode><StardustApp /></StrictMode>);
