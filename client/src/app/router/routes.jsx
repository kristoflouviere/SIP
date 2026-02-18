import { Navigate } from "react-router-dom";
import MainApp from "../../App.jsx";

export const routes = [
  { path: "/", element: <MainApp routeView="app" /> },
  { path: "/contacts", element: <MainApp routeView="contacts" /> },
  { path: "/admin/dev-consoles", element: <MainApp routeView="dev" /> },
  { path: "/admin/database", element: <MainApp routeView="database" /> },
  { path: "*", element: <Navigate to="/" replace /> }
];
