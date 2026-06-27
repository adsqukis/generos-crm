# GENEROS CRM SYSTEM - COMPLETE SPECIFICATION

## 1. CORE DATA MODEL

### 1.1 CUSTOMERS TABLE
```
customers {
  id: UUID (primary)
  phone_number: STRING (UNIQUE) - Format: 62XXXXXXXXXX
  name: STRING
  email: STRING (nullable)
  date_added: DATE (when first imported)
  last_interaction_date: DATE
  status: ENUM [active, inactive, churned]
  
  // Calculated fields (auto-updated)
  rfm_score: STRING (e.g., "A1", "B2", "C3")
  rfm_recency: INT (days since last purchase)
  rfm_frequency: INT (total purchases)
  rfm_monetary: DECIMAL (total spend)
  
  cohort_id: UUID (FK)
  current_segment_id: UUID (FK)
  previous_segment_id: UUID (FK - for audit)
  segment_change_date: DATE
  
  created_at: TIMESTAMP
  updated_at: TIMESTAMP
  created_by: UUID (FK to users)
  updated_by: UUID (FK to users)
}
```

### 1.2 PURCHASES TABLE
```
purchases {
  id: UUID (primary)
  customer_phone: STRING (FK to customers.phone_number)
  purchase_date: DATE
  purchase_amount: DECIMAL (validated: > 0)
  product_category: STRING (e.g., "milk", "snacks", "apparel")
  quantity: INT
  source: ENUM [d2c_website, marketplace, retail, other]
  
  created_at: TIMESTAMP
  created_by: UUID
}
```

### 1.3 COHORTS TABLE
```
cohorts {
  id: UUID (primary)
  cohort_name: STRING (e.g., "Jan 2024", "Q1 2024")
  cohort_type: ENUM [monthly, quarterly, custom]
  start_date: DATE
  end_date: DATE (nullable for ongoing)
  
  // Auto-calculated metrics
  total_customers: INT
  customers_with_repeat: INT
  repeat_purchase_rate: DECIMAL (%) - calculated daily
  avg_ltv: DECIMAL
  avg_first_to_repeat_days: INT
  churn_rate: DECIMAL (%) - customers inactive 90+ days
  days_30_retention: DECIMAL (%)
  days_60_retention: DECIMAL (%)
  days_90_retention: DECIMAL (%)
  
  created_at: TIMESTAMP
  updated_at: TIMESTAMP
}

// COHORT ASSIGNMENT RULE:
// Assigned based on date_added month/quarter
// If customer has purchases in multiple months, still assigned to FIRST purchase month
// Re-assignment only if manual override by admin
```

### 1.4 SEGMENTS TABLE
```
segments {
  id: UUID (primary)
  segment_name: STRING (e.g., "High-Value Repeat")
  description: TEXT
  priority: INT (1=highest, for conflict resolution)
  
  // RFM Rules (all must be TRUE for assignment)
  rfm_recency_min: INT (days)
  rfm_frequency_min: INT (purchases)
  rfm_monetary_min: DECIMAL (total spend)
  
  // Additional rules (optional)
  cohort_min_age_days: INT (nullable - customer must be in cohort X+ days)
  product_category_filter: ARRAY[STRING] (nullable - only if purchased X categories)
  exclude_rule: STRING (SQL WHERE clause for exclusions)
  
  // Strategy mapping
  assigned_promo_strategy_id: UUID (FK)
  contact_frequency: ENUM [high, medium, low] (emails/month target)
  contact_method: ARRAY [email, sms, whatsapp]
  
  customer_count: INT (auto-calculated)
  last_recalculated: TIMESTAMP
  
  created_at: TIMESTAMP
  created_by: UUID
  updated_at: TIMESTAMP
  updated_by: UUID
}
```

### 1.5 RFM SCORE DEFINITION

**Scoring Matrix (based on product type: milk/snacks/apparel mix):**

| Score | Recency | Frequency | Monetary |
|-------|---------|-----------|----------|
| **1** | 0-15 days | 5+ times | $500+ |
| **2** | 16-30 days | 3-4 times | $250-499 |
| **3** | 31-60 days | 2 times | $100-249 |
| **4** | 61-90 days | 1 time | $50-99 |
| **5** | 90+ days | 0 times (churned) | <$50 |

**RFM Combinations → Segment Mapping:**

```
TIER A (High-Value Repeat):
├── R1-2, F3+, M2+ → "Premium Loyal"
└── R2-3, F4+, M2+ → "Power Buyer"

TIER B (Mid-Tier):
├── R2-3, F2-3, M2-3 → "Regular Customer"
└── R3-4, F2, M2-3 → "Occasional Buyer"

TIER C (Low-Frequency/At-Risk):
├── R4-5, F1, M3-4 → "One-Time Buyer"
└── R4-5, F0, M4+ → "Churned High-Value" (re-engagement priority)

TIER D (Inactive):
└── R5, F0, M4-5 → "Dormant" (low priority)
```

**RFM Recalculation:**
- Trigger: Daily at 2 AM (batch job)
- Only recalculates if new purchases since last calc
- Timestamp: `cohorts.last_recalculated`

---

## 2. SEGMENT ASSIGNMENT LOGIC

### 2.1 Conflict Resolution (Customer matches multiple segments)

**Rule: PRIORITY-BASED ASSIGNMENT**

```
IF customer matches multiple segments:
  → Assign to segment with HIGHEST priority
  → REASON: Simplify follow-up (1 segment per customer at a time)
  → Log: previous_segment_id + change reason + who changed it
  
ELSE IF no segments match:
  → segment_id = NULL
  → system sends alert: "X customers unassigned"
  → Manual review required by marketing_manager
```

**Example:**
- Customer A matches: "Premium Loyal" (priority 1) + "Power Buyer" (priority 2)
- Assignment: "Premium Loyal"
- Reason logged: "Conflict resolved via priority"

### 2.2 Segment Reassignment Rules

```
AUTO-REASSIGNMENT TRIGGER:
├── Weekly (every Monday 9 AM):
│   └── Recalculate RFM
│   └── Check if customer should move to different segment
│   └── If YES: Create task (approval_required = TRUE)
│
APPROVAL WORKFLOW:
├── If segment_change significant (e.g., High-Value → Low-Freq):
│   └── Requires marketing_manager approval
│
├── If segment_change minor (e.g., Regular → Occasional):
│   └── Auto-approve (notify only)
│
└── All changes logged with audit trail:
    {
      old_segment, new_segment, reason, approved_by, timestamp
    }
```

---

## 3. PROMO STRATEGY SYSTEM

### 3.1 PROMO STRATEGY TABLE
```
promo_strategies {
  id: UUID (primary)
  strategy_name: STRING (e.g., "15% Loyalty Discount")
  description: TEXT
  
  // Execution parameters
  discount_type: ENUM [percentage, fixed_amount]
  discount_value: DECIMAL (% or $)
  coupon_code: STRING (auto-generated or manual)
  validity_days: INT (how long coupon valid)
  
  // Delivery rules
  delivery_channel: ENUM [email, sms, whatsapp, in_app]
  delivery_frequency: ENUM [one_time, weekly, monthly, bi_weekly]
  delivery_trigger: ENUM [on_segment_assignment, on_schedule, on_purchase]
  
  // Business constraints
  min_purchase_amount: DECIMAL (coupon valid only if order > X)
  applicable_categories: ARRAY[STRING] (null = all products)
  max_redemptions: INT (global cap - optional)
  max_per_customer: INT (e.g., 1 per month)
  
  // Performance tracking
  budget_allocated: DECIMAL (total discount budget)
  budget_used: DECIMAL (auto-tracked)
  budget_remaining: DECIMAL (auto-calculated)
  
  // Testing
  is_a_b_test: BOOLEAN
  test_variant_a_id: UUID (FK - nullable)
  test_variant_b_id: UUID (FK - nullable)
  test_split_ratio: DECIMAL (0.5 = 50/50)
  
  status: ENUM [draft, active, paused, completed, archived]
  created_at: TIMESTAMP
  created_by: UUID
  updated_at: TIMESTAMP
  updated_by: UUID
  approved_at: TIMESTAMP
  approved_by: UUID (nullable - if approval required)
}
```

### 3.2 Promo Execution Flow

```
WORKFLOW:
1. Segment assigned → Customer matches segment + promo_strategy

2. Generate Coupon:
   └── Auto-create: "GENEROS_<SEGMENT>_<RANDOM6CHARS>"
   └── Store in promo_redemptions table

3. Delivery:
   ├── IF delivery_trigger = "on_segment_assignment":
   │   └── Send immediately via selected channel(s)
   │
   └── IF delivery_trigger = "on_schedule":
       └── Queue in task scheduler (cronJob)

4. Redemption Tracking:
   ├── Track: Customer phone + coupon_code + amount_redeemed
   ├── Validate: min_purchase_amount, validity_days, max_per_customer
   └── Update: budget_used, promo_redemptions log

5. Performance Analysis:
   ├── Redemption rate (% who used coupon)
   ├── Revenue impact (revenue from users with coupon vs without)
   ├── ROI = (revenue_generated - discount_spent) / discount_spent
   └── Quarterly review (decide continue/pause/iterate)
```

### 3.3 A/B Testing Capability

```
EXAMPLE: Test 2 strategies on "High-Value Repeat" segment
├── Variant A: 15% discount, weekly email
├── Variant B: 10% discount + free shipping, bi-weekly email
├── Split: 50/50 random assignment

TRACKING:
├── Variant A: 625 customers, 42% redemption, $5,200 spend, $780 discount
├── Variant B: 625 customers, 38% redemption, $4,800 spend, $600 discount
└── Winner: Variant A (higher ROI)

RESULT:
├── Roll out Variant A to all "High-Value Repeat"
├── Archive Variant B
└── Log result + decision maker in audit trail
```

---

## 4. FOLLOW-UP TASK WORKFLOW

### 4.1 FOLLOW_UP_TASKS TABLE
```
follow_up_tasks {
  id: UUID (primary)
  customer_phone: STRING (FK)
  segment_id: UUID (FK)
  promo_strategy_id: UUID (FK - nullable)
  
  task_type: ENUM [send_promo, re_engagement, win_back, feedback_request, other]
  task_title: STRING
  description: TEXT (template: "Send 15% discount to {{name}}")
  
  // Scheduling
  scheduled_date: DATE
  scheduled_time: TIME (nullable - if batch email, use default)
  send_immediately: BOOLEAN
  
  // Assignment
  assigned_to_user_id: UUID (FK to users)
  assigned_by_user_id: UUID
  assigned_at: TIMESTAMP
  
  // Execution
  channel: ENUM [email, sms, whatsapp, manual_call]
  message_template_id: UUID (FK)
  personalized_message: TEXT (generated with Deepseek or template)
  
  // Status tracking
  status: ENUM [pending, in_progress, sent, failed, skipped, completed]
  status_updated_at: TIMESTAMP
  
  // Performance
  opened: BOOLEAN (for email, if trackable)
  clicked: BOOLEAN (if trackable)
  converted: BOOLEAN (made purchase within 30 days)
  conversion_amount: DECIMAL (nullable)
  
  // Approval
  requires_approval: BOOLEAN (if manual call or high-value)
  approved_by_user_id: UUID (nullable)
  approved_at: TIMESTAMP (nullable)
  
  notes: TEXT (for manual actions)
  retry_count: INT (if failed, auto-retry up to 3x)
  last_retry: TIMESTAMP
  
  created_at: TIMESTAMP
  created_by: UUID
  updated_at: TIMESTAMP
}
```

### 4.2 Follow-Up Workflow Rules

```
AUTOMATIC TASK GENERATION:

1. ON SEGMENT ASSIGNMENT:
   └── Create follow_up_task for promo delivery
       ├── type: send_promo
       ├── scheduled_date: TODAY (or tomorrow if after 5 PM)
       ├── channel: from promo_strategy.delivery_channel
       └── assigned_to: round-robin (sales team)

2. ON PURCHASE (any customer):
   └── Create "thank you" task
       ├── type: feedback_request
       ├── scheduled_date: TODAY + 3 days
       ├── channel: email
       └── assigned_to: auto-system (no user needed)

3. CHURN DETECTION (90+ days no purchase):
   └── Create re-engagement task
       ├── type: re_engagement
       ├── segment_id: mapped to "Churned" segment
       ├── scheduled_date: TODAY
       ├── assigned_to: marketing_manager
       └── requires_approval: FALSE (auto-send)

4. ESCALATION (pending task > 7 days):
   └── System alert: "X tasks overdue"
       ├── assigned_to_user gets reminder
       ├── escalates to manager if not completed in 3 days
       └── log in audit trail


COMPLETION RULES:
├── Manual channel (call): assigned_to_user marks as "completed" manually
├── Email/SMS: auto-mark "sent" when delivery confirmed
├── Conversion tracking: monitor purchase within 30 days of task send_date
└── Report: weekly summary (completed %, conversion %, ROI per task type)
```

### 4.3 Escalation & Approval

```
APPROVAL REQUIRED FOR:
├── Manual calls to customers (requires marketing_manager review)
├── High-value promo (discount > $50 per customer)
├── Segment reassignment from High-Value → Inactive
└── Budget override (spend more than allocated)

ESCALATION RULES:
├── IF task.status = "pending" AND TODAY > scheduled_date + 7 days:
│   └── Send escalation email to task.assigned_to_user's manager
│
└── IF task.status = "failed" AND retry_count >= 3:
    └── Mark as "manual_review_needed"
    └── Alert: assigned_to_user + manager
```

---

## 5. DEEPSEEK AI INTEGRATION

### 5.1 AI Capabilities (Gated)

```
CAPABILITY 1: STRATEGY RECOMMENDATION ENGINE
├── Input: cohort_id, segment_id (or customer data)
├── Analysis: ROI, retention trends, competitive benchmarking
├── Output: Suggest promo strategy with confidence score (0-100%)
├── Example output:
│   {
│     "recommendation": "Increase discount to 18% (from 15%)",
│     "reason": "Q1 cohort shows price sensitivity, 15% redemption low vs 35% industry avg",
│     "confidence": 78,
│     "estimated_impact": {
│       "redemption_rate_increase": "+8%",
│       "revenue_impact": "+$2,400/month",
│       "roi": "240%"
│     },
│     "requires_approval": true
│   }
└── Trigger: Manual request OR auto when segment created

CAPABILITY 2: PATTERN ANALYSIS & ROOT CAUSE
├── Input: Customer query (e.g., "Why is cohort X churn high?")
├── Analysis: Compare multiple dimensions
├── Output: Root cause hypothesis + recommendations
├── Constraints:
│   └── Max analysis depth: last 6 months data
│   └── Cannot make definitive claims (use "likely", "suggests")
│   └── Must cite data sources (cohort name, exact metrics)
└── Trigger: Manual query only

CAPABILITY 3: CHAT INTERFACE (Natural language queries)
├── Input: Free-form question about CRM data
├── Supported queries:
│   ├── "How many Jan cohort customers repeat purchased?"
│   ├── "Which segment has highest churn?"
│   ├── "Compare Q1 vs Q2 repeat rates"
│   └── "What's the avg LTV per segment?"
├── Output: Answer + data source
├── Constraint: Cannot edit/delete data (read-only)
└── Trigger: Always available, user-initiated
```

### 5.2 Deepseek Context & Guardrails

```
SYSTEM PROMPT:
"You are CRM assistant for Generos (kids product brand: milk, snacks, apparel).

DATA ACCESS: You can see all customer and cohort data (no PII restrictions for internal analysis).

YOUR ROLE:
1. Analyze cohort/segment performance using provided metrics
2. Suggest promo strategies based on customer behavior
3. Answer factual questions about CRM data
4. Identify patterns and anomalies

CONSTRAINTS:
- Use actual numbers from data (don't estimate)
- Preface recommendations with confidence level (0-100%)
- Never recommend strategy without ROI estimate
- Flag uncertainty: 'Data insufficient' if <100 customers in segment
- Keep language actionable (not just descriptive)
- All claims must be backed by specific metrics

GUARDRAILS:
- Cannot suggest discount > 50% (business rule)
- Cannot recommend strategy for unassigned customers (flag as error)
- Must include approval workflow if recommendation is strategic
- If A/B test required, explain why and design"

CONTEXT INJECTED PER REQUEST:
{
  "user_id": "user_123",
  "user_role": "marketing_manager",
  "request_timestamp": "2024-06-20T14:30:00Z",
  
  "available_cohorts": [
    {
      "id": "cohort_jan2024",
      "name": "Jan 2024",
      "total_customers": 1250,
      "repeat_rate": 0.68,
      "avg_ltv": 450,
      "churn_rate": 0.12,
      "days_30_retention": 0.85
    }
    // ... more cohorts
  ],
  
  "available_segments": [
    {
      "id": "seg_high_value",
      "name": "High-Value Repeat",
      "customer_count": 1250,
      "repeat_rate": 0.68,
      "current_strategy": "15% discount, weekly email"
    }
    // ... more segments
  ],
  
  "business_constraints": {
    "max_discount_pct": 50,
    "min_cohort_size_for_analysis": 100,
    "budget_remaining": 5200,
    "discount_spent_ytd": 12400
  }
}

RESPONSE VALIDATION:
├── Check: All metrics cited have corresponding data point
├── Check: Recommendation doesn't violate business_constraints
├── Check: Confidence level reasonable (not always 99%)
└── Check: Include data source (cohort name, specific metrics)
```

### 5.3 AI Request Flow

```
USER: "Why is Q1 repeat rate lower than expected?"

BACKEND PROCESSING:
1. Extract query intent: analyze_cohort_performance
2. Fetch cohort data: Q1 2024 metrics + compare Q2, Q3
3. Inject context: competitors avg (from hardcoded config)
4. Call Deepseek API with system prompt + context

DEEPSEEK RESPONSE:
{
  "analysis": "Q1 cohort shows 68% repeat vs 45% Q2 average...",
  "likely_reasons": [
    "Early adoption effect - customers still testing products",
    "Seasonal demand - milk products higher demand Jan-Feb",
    "Price sensitivity - Q1 had higher discount rates"
  ],
  "confidence": 72,
  "recommended_action": "Segment Q1 customers separately, test 10% lower discount to see if retention improves",
  "requires_follow_up": true
}

FRONTEND DISPLAY:
├── Show analysis in chat
├── Show [Approve Recommendation] button if requires_follow_up = true
├── Clicking button → Create follow_up_task + promo_strategy (draft)
└── Manager can review before activation
```

### 5.4 Chat History & Audit

```
CHAT_HISTORY TABLE:
chat_messages {
  id: UUID
  user_id: UUID
  message_text: TEXT (what user asked)
  message_type: ENUM [user_query, ai_response]
  
  // For AI responses
  ai_model: STRING ("deepseek-v3")
  ai_context_used: JSON (what data was injected)
  ai_confidence: DECIMAL
  
  // Approval tracking
  approved: BOOLEAN
  approved_by: UUID (if user approved recommendation)
  approved_at: TIMESTAMP
  
  created_at: TIMESTAMP
  conversation_id: UUID (group related chats)
}

// Keep chat history for 1 year for compliance/debugging
```

---

## 6. DATA QUALITY & UPLOAD VALIDATION

### 6.1 Upload Processing Rules

```
CSV COLUMNS REQUIRED:
├── phone_number (mandatory, unique, format: 62XXXXXXXXXX)
├── name (mandatory, min 2 chars)
├── purchase_date (mandatory, ISO format: YYYY-MM-DD)
└── purchase_amount (mandatory, > 0)

OPTIONAL COLUMNS:
├── email
├── product_category
└── quantity

VALIDATION RULES:

1. PHONE NUMBER:
   ├── Format: /^62[0-9]{9,12}$/ (Indonesia format)
   ├── IF format invalid → skip row, log error
   ├── IF duplicate in current upload → merge (sum purchases)
   ├── IF exists in DB → update (merge new purchases)

2. PURCHASE_DATE:
   ├── Must be valid date
   ├── Cannot be future date (flag if > TODAY)
   ├── Must be >= date_added (first contact)

3. PURCHASE_AMOUNT:
   ├── Must be decimal > 0
   ├── Cannot exceed 10,000,000 (data validation - likely typo)
   ├── IF invalid → skip row, log error

4. DUPLICATE HANDLING:
   ├── IF same phone in single upload multiple times:
   │   └── Merge: sum amounts, keep latest date
   │
   └── IF phone exists in DB:
       ├── Check last_interaction_date in DB
       ├── Merge new purchase with existing purchase history
       └── Recalculate RFM

UPLOAD RESULT:
├── Success: X rows processed, Y new customers, Z updated
├── Errors: X rows skipped (invalid data)
├── Summary: JSON {success_count, error_count, error_log}
└── Post-upload: Trigger RFM recalculation, cohort assignment
```

### 6.2 Data Validation Edge Cases

```
EDGE CASE 1: Phone duplicate in historical data
├── Scenario: Customer "08123456789" has purchase on Jan 1 and Jan 15
├── Action: Combine into 1 customer record
├── Recalculate: RFM, cohort assignment

EDGE CASE 2: Same phone, different names
├── Scenario: Upload has "08123456789, Budi" but DB has "08123456789, Budiman"
├── Action: Flag for manual review (potential data error)
├── Decision: Marketing manager can merge or keep separate

EDGE CASE 3: Missing purchase_amount
├── Scenario: Row has phone, name, date but no amount
├── Action: Skip row, log error "Missing purchase amount"

EDGE CASE 4: Negative purchase amount
├── Scenario: Return/refund indicated as negative
├── Action: Flag for manual review (system assumes additions only for now)

EDGE CASE 5: Purchase date in future
├── Scenario: Date = 2024-12-31 (today is 2024-06-20)
├── Action: Skip row, log warning "Future date detected"

EDGE CASE 6: Purchase date before customer date_added
├── Scenario: Customer added 2024-02-01, but purchase date 2024-01-15
├── Action: Auto-correct date_added to purchase_date
└── Reason: First purchase = when customer joined
```

---

## 7. ROLE-BASED ACCESS CONTROL

```
ROLES:

1. ADMIN (full access)
   ├── View: All data (CRM, cohort, segment, chat)
   ├── Edit: User management, system settings
   ├── Approve: Strategy changes, budget overrides
   └── Access: Upload, all tabs

2. MARKETING_MANAGER
   ├── View: All data (read)
   ├── Edit: Segment definitions, promo strategies
   ├── Approve: Follow-up tasks, re-engagement campaigns
   ├── Access: All tabs
   └── Deepseek: Full access (strategy recommendations)

3. SALES_LEAD
   ├── View: Customer data, assigned follow-ups
   ├── Edit: Customer notes, task status
   ├── Approve: None
   ├── Access: CRM, Chat (limited)
   └── Deepseek: Query only (no recommendations)

4. ANALYST
   ├── View: Cohort/segment metrics (read-only)
   ├── Edit: None
   ├── Approve: None
   ├── Access: Overview, Cohort, STP (read-only)
   └── Deepseek: Limited (no sensitive strategies)

5. TEAM_MEMBER (basic)
   ├── View: Assigned follow-ups only
   ├── Edit: Task completion status
   ├── Approve: None
   ├── Access: Follow-up task list only
   └── Deepseek: None

AUTHENTICATION:
├── Email + password (initial)
├── Optional: 2FA for admin/marketing_manager
├── Session timeout: 8 hours
└── Audit log: Login attempts, role changes
```

---

## 8. AUDIT & COMPLIANCE

### 8.1 Audit Log Tracking

```
AUDIT_LOG TABLE:
audit_logs {
  id: UUID
  user_id: UUID
  action: ENUM [create, update, delete, approve, reject]
  entity_type: ENUM [customer, segment, promo_strategy, task, cohort]
  entity_id: UUID
  
  old_value: JSON (before change)
  new_value: JSON (after change)
  reason: TEXT (why changed)
  
  timestamp: TIMESTAMP
  ip_address: STRING (for security)
}

EVENTS LOGGED:
├── Segment rule changes (old RFM thresholds vs new)
├── Promo strategy creation/approval/pause
├── Follow-up task completion/failure
├── Deepseek recommendations + approval
├── User role changes
├── Large data uploads (>1000 rows)
└── Budget allocation changes
```

### 8.2 Data Retention & Privacy

```
RETENTION POLICY:
├── Customer purchase data: Keep 3 years (for LTV analysis)
├── Chat history: Keep 1 year (for debugging)
├── Audit logs: Keep 2 years (compliance)
├── Failed tasks: Keep 6 months

GDPR/PRIVACY:
├── Phone number = personal data (handle carefully)
├── Export function: Restricted to admin only
├── Deletion: If customer requests, soft-delete (mark status = deleted)
├── Data access: All queries logged
```

---

## 9. PERFORMANCE METRICS & REPORTING

### 9.1 Dashboard Metrics

```
OVERVIEW DASHBOARD:
├── Total Active Customers (this month)
├── New Customers (this month)
├── Overall Repeat Purchase Rate (%)
├── Average LTV (all customers)
├── Pending Follow-ups (count)
├── Recent Uploads (last 5)

COHORT DASHBOARD:
├── Cohort Performance Table:
│   ├── Repeat Rate (%), LTV, Churn Rate (%)
│   ├── Days 30/60/90 Retention
│   └── Trend (up/down vs previous period)

SEGMENT DASHBOARD:
├── Segment Performance Cards:
│   ├── Customer count, Repeat %, LTV
│   ├── Assigned strategy, Contact frequency
│   └── Last reassignment date

PROMO DASHBOARD:
├── Active Promos Table:
│   ├── Redemption rate (%)
│   ├── Budget spent / allocated
│   ├── ROI = (revenue - discount) / discount
│   └── Conversion rate within 30 days

TASK DASHBOARD:
├── Follow-up Completion Rate (%)
├── Overdue Tasks (count)
├── Conversion by Task Type (email vs SMS vs call)
└── Weekly Trend (tasks completed)

DEEPSEEK USAGE:
├── Requests this month
├── Recommendations approved/rejected
├── AI-driven strategy results (ROI)
```

### 9.2 Reports (Auto-generated)

```
WEEKLY REPORT (Monday 9 AM):
├── New customers added
├── Segment changes (who moved where)
├── Task completion rate
├── Top 3 promo ROI this week

MONTHLY REPORT (1st of month):
├── Cohort performance summary
├── Promo effectiveness (ROI per strategy)
├── Churn analysis
├── Recommendations for next month

QUARTERLY REPORT:
├── Segment strategy effectiveness
├── Budget vs spend
├── A/B test results
├── Customer lifetime value trends
```

---

## 10. TECHNICAL ARCHITECTURE

### 10.1 API Endpoints

```
// CUSTOMERS
GET /api/customers (with filters: phone, segment, cohort)
GET /api/customers/{phone}
POST /api/customers/search (advanced search)
PUT /api/customers/{phone} (update notes, status)
GET /api/customers/{phone}/history (purchase history)

// UPLOADS
POST /api/uploads (file upload)
GET /api/uploads (recent uploads list)
GET /api/uploads/{id}/status (upload progress)

// COHORTS
GET /api/cohorts (list all)
GET /api/cohorts/{id}/metrics
GET /api/cohorts/{id}/customers

// SEGMENTS
GET /api/segments (list all)
POST /api/segments (create new)
PUT /api/segments/{id} (update rules)
GET /api/segments/{id}/assigned_customers
GET /api/segments/{id}/performance

// PROMO STRATEGIES
GET /api/promo-strategies
POST /api/promo-strategies (create)
PUT /api/promo-strategies/{id} (update)
POST /api/promo-strategies/{id}/approve (approval workflow)
GET /api/promo-strategies/{id}/performance (ROI metrics)

// FOLLOW-UP TASKS
GET /api/tasks (assigned to user)
GET /api/tasks/all (admin view)
PATCH /api/tasks/{id}/status (update status)
POST /api/tasks (create new)
GET /api/tasks/overdue (escalation)

// CHAT / DEEPSEEK
POST /api/chat/message (send query)
GET /api/chat/history (get conversation)
POST /api/chat/recommendations/approve (approve AI suggestion)

// REPORTING
GET /api/reports/weekly
GET /api/reports/monthly
GET /api/reports/custom (custom date range)

// AUDIT
GET /api/audit-logs (admin only)
GET /api/audit-logs?entity_id={id} (track entity changes)
```

### 10.2 Database Schema (PostgreSQL)

```
// Indexes for performance
CREATE INDEX idx_customers_phone ON customers(phone_number);
CREATE INDEX idx_customers_cohort ON customers(cohort_id);
CREATE INDEX idx_customers_segment ON customers(current_segment_id);
CREATE INDEX idx_purchases_customer ON purchases(customer_phone);
CREATE INDEX idx_tasks_customer ON follow_up_tasks(customer_phone);
CREATE INDEX idx_tasks_status ON follow_up_tasks(status);

// Partitioning
PARTITION purchases BY RANGE (purchase_date) INTERVAL 1 MONTH;
  // For large datasets: separate old purchases into partitions

// Views (for dashboards)
CREATE VIEW cohort_metrics AS
  SELECT cohort_id, COUNT(*) as total_customers,
         SUM(rfm_frequency > 1) / COUNT(*) as repeat_rate,
         AVG(rfm_monetary) as avg_ltv
  FROM customers
  GROUP BY cohort_id;
```

---

## 11. IMPLEMENTATION ROADMAP

### Phase 1: Core (Weeks 1-4)
- [x] Database schema setup
- [x] Customer upload + import
- [x] RFM calculation
- [x] Cohort assignment
- [x] Basic dashboard (overview + CRM)

### Phase 2: Segmentation & Strategy (Weeks 5-8)
- [ ] Segment creation + assignment logic
- [ ] Promo strategy management
- [ ] Task creation + scheduling
- [ ] Email integration (send promos)

### Phase 3: AI Integration (Weeks 9-12)
- [ ] Deepseek API integration
- [ ] Chat interface
- [ ] Strategy recommendations
- [ ] Pattern analysis

### Phase 4: Advanced Features (Weeks 13+)
- [ ] A/B testing framework
- [ ] Advanced reporting
- [ ] Mobile app
- [ ] Marketplace integrations (Shopify, etc.)

---

## 12. DECISION LOG

**Q: Why batch RFM recalculation vs real-time?**
A: Daily batch sufficient for weekly segment assignments. Real-time adds unnecessary complexity.

**Q: Why phone = unique ID vs email?**
A: Indonesia market: phone more stable than email (easier to change email). Phone = primary contact method.

**Q: Why priority-based conflict resolution vs multiple segments?**
A: Simplifies follow-up workflow. Customer gets 1 clear strategy, not conflicting messages.

**Q: Why Deepseek instead of local ML?**
A: Faster iteration, no model training needed, natural language flexibility, cost-effective for low volume.

**Q: Why approval workflow for some tasks?**
A: High-value decisions (discount > $50, budget override) need human validation to prevent waste.

**Q: Why 90-day churn definition?**
A: Standard in FMCG (regular purchase cycle for kids products ~30-60 days; 90 days = lost customer).

---

**VERSION:** 1.0  
**LAST UPDATED:** 2024-06-20  
**OWNER:** Engineering Team  
**STATUS:** Ready for Development
