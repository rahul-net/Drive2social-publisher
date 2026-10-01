import { BrowserRouter, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./components/RequireAuth";
import { OfflineBanner } from "./components/OfflineBanner";
import { DashboardPage } from "./pages/Dashboard";
import { DriveVideosPage } from "./pages/DriveVideos";
import { CreatePostPage } from "./pages/CreatePost";
import { UploadQueuePage } from "./pages/UploadQueue";
import { HistoryPage } from "./pages/History";
import { AccountsPage } from "./pages/Accounts";
import { SettingsPage } from "./pages/Settings";
import { SignInPage } from "./pages/SignIn";

/** /signin stays public; everything else requires Firebase auth. */
export function App() {
  return (
    <BrowserRouter>
      <OfflineBanner />
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/drive"
          element={
            <RequireAuth>
              <DriveVideosPage />
            </RequireAuth>
          }
        />
        <Route
          path="/create"
          element={
            <RequireAuth>
              <CreatePostPage />
            </RequireAuth>
          }
        />
        <Route
          path="/queue"
          element={
            <RequireAuth>
              <UploadQueuePage />
            </RequireAuth>
          }
        />
        <Route
          path="/history"
          element={
            <RequireAuth>
              <HistoryPage />
            </RequireAuth>
          }
        />
        <Route
          path="/accounts"
          element={
            <RequireAuth>
              <AccountsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <SettingsPage />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
