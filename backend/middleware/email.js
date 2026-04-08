// middleware/email.js
// Uses Resend (https://resend.com) — sends over HTTPS, works on Render free tier.
// SMTP is blocked on Render. Resend is free for 100 emails/day.
//
// Setup (5 minutes):
//   1. Go to https://resend.com and create a free account
//   2. Go to API Keys → Create API Key → copy it
//   3. Add to your Render environment variables:
//        RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
//        FRONTEND_URL=https://your-frontend.vercel.app
//
// That's it. No SMTP, no Gmail App Passwords, no port issues.

const RESEND_API_URL = 'https://api.resend.com/emails';

// From address — Resend free tier requires using their onboarding domain
// until you verify your own domain. Use this default or set EMAIL_FROM in .env.
function getFromAddress() {
return process.env.EMAIL_FROM || 'Food Spot AI <onboarding@resend.dev>';}

async function sendViaResend({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error(
      'RESEND_API_KEY is not set. ' +
      'Get a free key at https://resend.com → API Keys. ' +
      'Then add RESEND_API_KEY=re_xxx to your Render environment variables.'
    );
  }

  // Use a promise with a hard 12-second timeout
  const fetchPromise = fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    getFromAddress(),
      to:      [to],
      subject,
      html,
      text,
    }),
  });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Resend API timeout after 12s')), 12000)
  );

  const res = await Promise.race([fetchPromise, timeoutPromise]);
  const data = await res.json();

  if (!res.ok) {
    const errMsg = data?.message || data?.name || JSON.stringify(data);
    throw new Error(`Resend API error (${res.status}): ${errMsg}`);
  }

  console.log(`✅ Email sent via Resend → ${to} (id: ${data.id})`);
  return data;
}

// ── OTP Email ─────────────────────────────────────────────
async function sendOTPEmail(toEmail, toName, otp) {
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f9f7f4">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:#1a1512;padding:24px 32px">
      <span style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:#e8c17a">Food Spot AI 🍽️</span>
    </div>
    <div style="padding:32px">
      <h2 style="margin:0 0 8px;font-size:20px;color:#1a1512">Verify your email</h2>
      <p style="color:#5c5248;font-size:14px;margin:0 0 24px;line-height:1.6">
        Hi ${toName}, your one-time verification code is below. It expires in <strong>10 minutes</strong>.
      </p>
      <div style="background:#fdf8ef;border:2px solid #e8c17a;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <div style="font-size:11px;color:#c9921a;text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px;font-weight:700">Your OTP</div>
        <div style="font-size:52px;font-weight:800;letter-spacing:14px;color:#1a1512;font-family:Georgia,serif">${otp}</div>
      </div>
      <p style="color:#9c9188;font-size:12px;margin:0">Didn't create a Food Spot AI account? Ignore this email.</p>
    </div>
    <div style="background:#faf9f7;padding:14px 32px;border-top:1px solid #f0ede8">
      <p style="color:#c2beb9;font-size:11px;margin:0">© Food Spot AI · Restaurant Recommender</p>
    </div>
  </div></body></html>`;

  return sendViaResend({
    to:      toEmail,
    subject: `${otp} — Your Food Spot AI verification code`,
    html,
    text: `Your Food Spot AI verification code: ${otp}\n\nExpires in 10 minutes.\nDo not share this code with anyone.`,
  });
}

// ── Password Reset Email ──────────────────────────────────
async function sendPasswordResetEmail(toEmail, toName, resetToken) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const resetLink   = `${frontendUrl}/reset-password.html?token=${resetToken}&email=${encodeURIComponent(toEmail)}`;

  console.log(`🔗 Reset link for ${toEmail}: ${resetLink}`);

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f9f7f4">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:#1a1512;padding:24px 32px">
      <span style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:#e8c17a">Food Spot AI 🍽️</span>
    </div>
    <div style="padding:32px">
      <h2 style="margin:0 0 8px;font-size:20px;color:#1a1512">Reset your password</h2>
      <p style="color:#5c5248;font-size:14px;margin:0 0 24px;line-height:1.6">
        Hi ${toName}, click the button below to set a new password. This link expires in <strong>30 minutes</strong>.
      </p>
      <a href="${resetLink}" style="display:inline-block;background:#c9921a;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:14px;margin-bottom:20px">
        Reset Password →
      </a>
      <p style="color:#9c9188;font-size:12px;margin:0 0 8px">Or copy this link into your browser:</p>
      <p style="word-break:break-all;font-size:11px;color:#c2beb9;background:#faf9f7;padding:10px;border-radius:8px;border:1px solid #f0ede8">${resetLink}</p>
      <p style="color:#9c9188;font-size:12px;margin:16px 0 0">Didn't request a reset? Ignore this email.</p>
    </div>
    <div style="background:#faf9f7;padding:14px 32px;border-top:1px solid #f0ede8">
      <p style="color:#c2beb9;font-size:11px;margin:0">© Food Spot AI · Restaurant Recommender</p>
    </div>
  </div></body></html>`;

  return sendViaResend({
    to:      toEmail,
    subject: 'Reset your Food Spot AI password',
    html,
    text: `Reset your Food Spot AI password:\n\n${resetLink}\n\nExpires in 30 minutes. If you didn't request this, ignore it.`,
  });
}

// Startup check
setTimeout(() => {
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY not set — OTP and password reset emails will fail.');
    console.warn('   Get a free key at https://resend.com → sign up → API Keys');
  } else {
    console.log('✅ Resend email configured (key starts with:', process.env.RESEND_API_KEY.substring(0, 8) + '...)');
  }
  if (!process.env.FRONTEND_URL) {
    console.warn('⚠️  FRONTEND_URL not set — password reset links will be broken.');
  }
}, 1000);

module.exports = { sendOTPEmail, sendPasswordResetEmail };