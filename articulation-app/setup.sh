#!/bin/bash
echo "🚀 Setting up Smart Articulation Training System..."
echo ""

# Install dependencies
echo "📦 Installing Node.js dependencies..."
cd /home/user/articulation-app
npm install

# Copy uploaded files to public as backup
echo "📁 Setting up public directory..."
mkdir -p public uploads/videos data

# Create .env from example if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝 Created .env from .env.example"
  echo "   ⚠️  Edit .env to configure Gmail SMTP for OTP emails"
  echo "   Without SMTP config, OTPs will be shown in the server console"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start the server:"
echo "  cd /home/user/articulation-app"
echo "  npm start"
echo ""
echo "Then open http://localhost:3000 in your browser"
echo ""
echo "📧 To enable Gmail OTP delivery:"
echo "  1. Enable 2FA on your Google account"
echo "  2. Generate an App Password at https://myaccount.google.com/apppasswords"
echo "  3. Add your Gmail and App Password to .env"
echo ""
