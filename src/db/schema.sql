-- ============================================
-- GENEROS CRM - Database Schema
-- ============================================

-- Enable UUID extension

-- ============================================
-- USERS & AUTH
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'marketing_manager', 'sales_lead', 'analyst', 'team_member')),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- COHORTS
-- ============================================
CREATE TABLE IF NOT EXISTS cohorts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_name VARCHAR(100) UNIQUE NOT NULL,
  cohort_type VARCHAR(20) DEFAULT 'monthly' CHECK (cohort_type IN ('monthly', 'quarterly', 'custom')),
  start_date DATE NOT NULL,
  end_date DATE,
  total_customers INT DEFAULT 0,
  customers_with_repeat INT DEFAULT 0,
  repeat_purchase_rate DECIMAL(5,2) DEFAULT 0,
  avg_ltv DECIMAL(12,2) DEFAULT 0,
  avg_first_to_repeat_days INT DEFAULT 0,
  churn_rate DECIMAL(5,2) DEFAULT 0,
  days_30_retention DECIMAL(5,2) DEFAULT 0,
  days_60_retention DECIMAL(5,2) DEFAULT 0,
  days_90_retention DECIMAL(5,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- PROMO STRATEGIES
-- ============================================
CREATE TABLE IF NOT EXISTS promo_strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_name VARCHAR(255) NOT NULL,
  description TEXT,
  discount_type VARCHAR(20) CHECK (discount_type IN ('percentage', 'fixed_amount')),
  discount_value DECIMAL(10,2),
  coupon_code VARCHAR(50),
  validity_days INT DEFAULT 30,
  delivery_channel VARCHAR(20) CHECK (delivery_channel IN ('email', 'sms', 'whatsapp', 'in_app')),
  delivery_frequency VARCHAR(20) CHECK (delivery_frequency IN ('one_time', 'weekly', 'monthly', 'bi_weekly')),
  delivery_trigger VARCHAR(30) CHECK (delivery_trigger IN ('on_segment_assignment', 'on_schedule', 'on_purchase')),
  min_purchase_amount DECIMAL(10,2) DEFAULT 0,
  applicable_categories TEXT[],
  max_redemptions INT,
  max_per_customer INT DEFAULT 1,
  budget_allocated DECIMAL(12,2) DEFAULT 0,
  budget_used DECIMAL(12,2) DEFAULT 0,
  is_a_b_test BOOLEAN DEFAULT FALSE,
  test_split_ratio DECIMAL(3,2) DEFAULT 0.5,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT NOW(),
  approved_at TIMESTAMP,
  approved_by UUID REFERENCES users(id)
);

-- ============================================
-- SEGMENTS
-- ============================================
CREATE TABLE IF NOT EXISTS segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_name VARCHAR(255) NOT NULL,
  description TEXT,
  priority INT DEFAULT 100,
  rfm_recency_min INT,
  rfm_frequency_min INT,
  rfm_monetary_min DECIMAL(12,2),
  cohort_min_age_days INT,
  product_category_filter TEXT[],
  assigned_promo_strategy_id UUID REFERENCES promo_strategies(id),
  contact_frequency VARCHAR(20) CHECK (contact_frequency IN ('high', 'medium', 'low')),
  contact_method TEXT[],
  customer_count INT DEFAULT 0,
  last_recalculated TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT NOW(),
  updated_by UUID REFERENCES users(id)
);

-- ============================================
-- CUSTOMERS
-- ============================================
CREATE TABLE IF NOT EXISTS customers (
  phone_number VARCHAR(20) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  date_added DATE NOT NULL DEFAULT CURRENT_DATE,
  last_interaction_date DATE,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'churned', 'deleted')),
  rfm_score VARCHAR(5),
  rfm_recency INT,
  rfm_frequency INT DEFAULT 0,
  rfm_monetary DECIMAL(12,2) DEFAULT 0,
  cohort_id UUID REFERENCES cohorts(id),
  current_segment_id UUID REFERENCES segments(id),
  previous_segment_id UUID REFERENCES segments(id),
  segment_change_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id)
);

-- ============================================
-- PURCHASES
-- ============================================
CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_phone VARCHAR(20) REFERENCES customers(phone_number) ON DELETE CASCADE,
  purchase_date DATE NOT NULL,
  purchase_amount DECIMAL(12,2) NOT NULL CHECK (purchase_amount > 0),
  product_category VARCHAR(100),
  quantity INT DEFAULT 1,
  source VARCHAR(30) CHECK (source IN ('d2c_website', 'marketplace', 'retail', 'other')),
  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);

-- ============================================
-- FOLLOW-UP TASKS
-- ============================================
CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_phone VARCHAR(20) REFERENCES customers(phone_number) ON DELETE CASCADE,
  segment_id UUID REFERENCES segments(id),
  promo_strategy_id UUID REFERENCES promo_strategies(id),
  task_type VARCHAR(30) CHECK (task_type IN ('send_promo', 're_engagement', 'win_back', 'feedback_request', 'other')),
  task_title VARCHAR(255),
  description TEXT,
  scheduled_date DATE,
  send_immediately BOOLEAN DEFAULT FALSE,
  assigned_to_user_id UUID REFERENCES users(id),
  assigned_by_user_id UUID REFERENCES users(id),
  assigned_at TIMESTAMP,
  channel VARCHAR(20) CHECK (channel IN ('email', 'sms', 'whatsapp', 'manual_call')),
  personalized_message TEXT,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'sent', 'failed', 'skipped', 'completed')),
  status_updated_at TIMESTAMP,
  opened BOOLEAN DEFAULT FALSE,
  clicked BOOLEAN DEFAULT FALSE,
  converted BOOLEAN DEFAULT FALSE,
  conversion_amount DECIMAL(12,2),
  requires_approval BOOLEAN DEFAULT FALSE,
  approved_by_user_id UUID REFERENCES users(id),
  approved_at TIMESTAMP,
  notes TEXT,
  retry_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- PROMO REDEMPTIONS
-- ============================================
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_strategy_id UUID REFERENCES promo_strategies(id),
  customer_phone VARCHAR(20) REFERENCES customers(phone_number),
  coupon_code VARCHAR(50),
  amount_redeemed DECIMAL(12,2),
  discount_applied DECIMAL(12,2),
  redeemed_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- CHAT MESSAGES (Deepseek)
-- ============================================
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  user_id UUID REFERENCES users(id),
  message_text TEXT NOT NULL,
  message_type VARCHAR(20) CHECK (message_type IN ('user_query', 'ai_response')),
  ai_model VARCHAR(50),
  ai_confidence DECIMAL(5,2),
  approved BOOLEAN DEFAULT FALSE,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- AUDIT LOGS
-- ============================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  action VARCHAR(20) CHECK (action IN ('create', 'update', 'delete', 'approve', 'reject')),
  entity_type VARCHAR(30),
  entity_id VARCHAR(100),
  old_value JSONB,
  new_value JSONB,
  reason TEXT,
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- UPLOAD HISTORY
-- ============================================
CREATE TABLE IF NOT EXISTS upload_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name VARCHAR(255),
  uploaded_by UUID REFERENCES users(id),
  total_rows INT,
  success_count INT,
  error_count INT,
  error_log JSONB,
  status VARCHAR(20) DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Track which customers were created/updated by each upload
CREATE TABLE IF NOT EXISTS upload_customers (
  upload_id UUID REFERENCES upload_history(id) ON DELETE CASCADE,
  customer_phone VARCHAR(20) REFERENCES customers(phone_number) ON DELETE CASCADE,
  action VARCHAR(10) CHECK (action IN ('created', 'updated')),
  PRIMARY KEY (upload_id, customer_phone)
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_customers_cohort ON customers(cohort_id);
CREATE INDEX IF NOT EXISTS idx_customers_segment ON customers(current_segment_id);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_purchases_customer ON purchases(customer_phone);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date);
CREATE INDEX IF NOT EXISTS idx_tasks_customer ON follow_up_tasks(customer_phone);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON follow_up_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON follow_up_tasks(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_strategy ON promo_redemptions(promo_strategy_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversation ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
