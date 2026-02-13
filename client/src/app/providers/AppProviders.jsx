import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export default function AppProviders({ children }) {
  const [queryClient] = useState(() => new QueryClient());

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
