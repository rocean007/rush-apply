import { Outlet } from 'react-router-dom';
import Navbar from './Navbar';

export default function Layout() {
  return (
    <div className="mesh-bg noise min-h-screen">
      <Navbar />
      <main className="relative z-10">
        <Outlet />
      </main>
    </div>
  );
}
