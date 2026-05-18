import React from "react";
import ReactDOM from "react-dom/client";
import { SWRConfig } from "swr";
import App from "./App";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <SWRConfig value={{ errorRetryCount: 3, errorRetryInterval: 2000, keepPreviousData: true }}>
      <App />
    </SWRConfig>
  </React.StrictMode>
);
