import { Analytics } from "@vercel/analytics/react";

import { Home } from "./components/home";

import { getServerSideConfig } from "./config/server";
import { AuthContextProvider } from "./context/AuthContext";

const serverConfig = getServerSideConfig();

export default async function App() {
  return (
    <>
      <AuthContextProvider>
        <Home />
      </AuthContextProvider>
      {serverConfig?.isVercel && (
        <>
          <Analytics />
        </>
      )}
    </>
  );
}
