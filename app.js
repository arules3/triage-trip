// app.js
import { getUserProfile } from './user.js';
function renderDashboard() {
  const profile = getUserProfile("usr_123");
  
  // This line expects `userId`
  console.log(`Loading dashboard for user ID: ${profile.userID.toUpperCase()}`);
}
renderDashboard();