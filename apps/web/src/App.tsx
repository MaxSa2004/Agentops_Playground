import { useEffect, useState } from 'react'
import { runTriageWorkflow, simulateDecisions, type GeneratedTriageAssessment, type ProposedAction, type WorkflowInput } from '@agentops/core'
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, BadgeCheck, Boxes, BrainCircuit,
  Check, ChevronDown, CircleHelp, Clock3, Command, Cpu, Database, FileText, Gauge,
  GitBranch, LayoutDashboard, LockKeyhole, Menu, MoreHorizontal,
  Play, Plus, Search, Server, Settings2, Shield, ShieldAlert, Sparkles, WandSparkles,
  X,
} from 'lucide-react'

type Scenario = { label: string; input: WorkflowInput }
type DemoActionMode = 'allow' | 'approval' | 'block'
type PolicyView = { outcome: 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL'; reason: string }
type ApprovalView = { id?: string; status: 'pending' | 'approved' | 'executing' | 'rejected' | 'blocked' | 'executed' | 'demo_only' }
type ApiEventView = { id: string; type: string; timestamp: string; message: string; workflowId?: string; origin?: string; data?: Record<string, unknown> }
type OllamaStatusView = { available: boolean; model: string; modelAvailable: boolean; message?: string }
type McpToolView = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }
const scenarios: Scenario[] = [
  { label: 'Refund request', input: { ticketId: 'TK-2048', request: 'Analyse this customer’s refund request, retrieve the support ticket, determine urgency, and recommend the next action.', issueType: 'refund', customerImpact: 'single_customer', daysWaiting: 8 } },
  { label: 'Login issue', input: { ticketId: 'TK-1982', request: 'A customer cannot access their account after resetting their password. Find the ticket and recommend a safe next step.', issueType: 'account_access', customerImpact: 'single_customer', daysWaiting: 1 } },
  { label: 'Damaged delivery', input: { ticketId: 'TK-2116', request: 'Review the damaged delivery complaint and determine the right team and recommended action.', issueType: 'damaged_delivery', customerImpact: 'single_customer', daysWaiting: 3 } },
]

const demoMcpTools: McpToolView[] = [
  { name: 'list_tickets', description: 'List fictional support tickets', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'get_ticket', description: 'Retrieve a fictional ticket by ID', inputSchema: { ticketId: 'string: TK-0000' }, annotations: { readOnlyHint: true } },
  { name: 'search_knowledge_base', description: 'Search fictional support documentation', inputSchema: { query: 'string: 2–200 characters' }, annotations: { readOnlyHint: true } },
  { name: 'propose_ticket_action', description: 'Return a priority proposal without executing it', inputSchema: { ticketId: 'string', priority: 'low | normal | high | urgent' }, annotations: { readOnlyHint: true } },
  { name: 'update_ticket_priority', description: 'Change a ticket priority after backend authorization', inputSchema: { ticketId: 'string', priority: 'low | normal | high | urgent' }, annotations: { readOnlyHint: false } },
]

const timelineTitles: Record<string, string> = {
  task_received: 'Task received', decisions_generated: 'Typed decisions generated', tool_requested: 'Tool requested',
  tool_result: 'Tool result received', policy_evaluated: 'Policy evaluated', approval_requested: 'Approval requested',
  approval_granted: 'Approval granted', approval_execution_started: 'Approved action executing', approval_rejected: 'Approval rejected', action_executed: 'Action executed',
  action_blocked: 'Action blocked', execution_blocked: 'Execution blocked', demo_action_illustrated: 'Demo action illustrated',
  ollama_request_started: 'Local model request started', ollama_response_received: 'Model assessment received', ollama_error: 'Local model error',
  mcp_connection_established: 'MCP connection established', mcp_tools_discovered: 'MCP tools discovered',
  mcp_arguments_validated: 'Tool arguments validated', mcp_tool_failed: 'MCP tool failed', mcp_workflow_error: 'MCP workflow error',
  ollama_tool_selection_started: 'Model selecting read tool', ollama_tool_selection_invalid: 'Tool selection rejected',
  workflow_completed: 'Workflow completed',
}

function eventSourceLabel(origin: string | undefined, type: string, backendAvailable: boolean): string {
  if (origin === 'decision-simulator') return 'JEV-INSPIRED SIMULATION'
  if (origin === 'mcp-demo') return 'MCP DEMO — SIMULATED'
  if (origin === 'mcp-client') return 'MCP CLIENT'
  if (origin === 'mcp-server') return 'MCP SERVER'
  if (origin === 'policy-engine') return 'POLICY ENGINE'
  if (origin === 'policy-preview') return 'POLICY DEMO'
  if (origin === 'human') return 'HUMAN APPROVAL'
  if (origin === 'ollama') return backendAvailable ? 'OLLAMA AGENT' : 'OLLAMA DEMO — SIMULATED'
  if (origin === 'browser-demo') {
    if (type.startsWith('approval_')) return 'HUMAN APPROVAL · DEMO'
    if (type.startsWith('policy_') || type === 'action_blocked') return 'POLICY DEMO'
    return 'WORKFLOW DEMO — SIMULATED'
  }
  if (origin === 'workflow') return backendAvailable ? 'API / WORKFLOW' : 'WORKFLOW DEMO — SIMULATED'
  return backendAvailable ? 'API / WORKFLOW' : 'WORKFLOW DEMO — SIMULATED'
}

function App() {
  const [scenarioIndex, setScenarioIndex] = useState(0)
  const [workflowInput, setWorkflowInput] = useState<WorkflowInput>(scenarios[0].input)
  const [workflowResult, setWorkflowResult] = useState<ReturnType<typeof runTriageWorkflow> | null>(null)
  const [modelAssessment, setModelAssessment] = useState<GeneratedTriageAssessment | null>(null)
  const [running, setRunning] = useState(false)
  const [actionMode, setActionMode] = useState<DemoActionMode>('approval')
  const [actionSnapshot, setActionSnapshot] = useState<ProposedAction | null>(null)
  const [policyResult, setPolicyResult] = useState<PolicyView | null>(null)
  const [approvalInfo, setApprovalInfo] = useState<ApprovalView | null>(null)
  const [executionResult, setExecutionResult] = useState('')
  const [backendAvailable, setBackendAvailable] = useState(false)
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatusView | null>(null)
  const [mcpTools, setMcpTools] = useState<McpToolView[]>([])
  const [mcpConnected, setMcpConnected] = useState(false)
  const [runEvents, setRunEvents] = useState<ApiEventView[]>([])
  const [activeNav, setActiveNav] = useState('Overview')
  const [mobileNav, setMobileNav] = useState(false)
  const [notice, setNotice] = useState('')
  const previewDecisions = simulateDecisions(workflowInput)
  const selectedAction = (): ProposedAction => actionMode === 'allow'
    ? { type: 'read_ticket', ticketId: workflowInput.ticketId }
    : actionMode === 'block'
      ? { type: 'delete_ticket', ticketId: workflowInput.ticketId }
      : { type: 'update_ticket_priority', ticketId: workflowInput.ticketId, priority: 'high' }
  const approvalPending = policyResult?.outcome === 'REQUIRE_APPROVAL' && approvalInfo?.status === 'pending'
  const activeAction = actionSnapshot ?? selectedAction()
  const actionDescription = activeAction.type === 'read_ticket'
    ? `Read ticket ${activeAction.ticketId}`
    : activeAction.type === 'delete_ticket'
      ? `Delete ticket ${activeAction.ticketId}`
      : activeAction.type === 'update_ticket_priority'
        ? `Raise priority for ${activeAction.ticketId} to ${activeAction.priority}`
        : 'Search the support knowledge base'

  useEffect(() => {
    fetch('/api/health').then((response) => response.ok ? response.json() : null).then((health: { status?: string; mode?: string; ollama?: OllamaStatusView; mcp?: { connected: boolean } } | null) => {
      if (health?.status === 'ok' && health?.mode === 'local-api') {
        setBackendAvailable(true)
        setOllamaStatus(health.ollama ?? null)
        setMcpConnected(Boolean(health.mcp?.connected))
        void requestApi<{ tools: McpToolView[] }>('/api/mcp/tools', { method: 'GET' }).then((result) => setMcpTools(result.tools)).catch(() => setMcpConnected(false))
      }
    }).catch(() => setBackendAvailable(false))
  }, [])

  const pickScenario = (index: number) => {
    setScenarioIndex(index)
    setWorkflowInput(scenarios[index].input)
    setWorkflowResult(null)
    setModelAssessment(null)
    setActionSnapshot(null)
    setPolicyResult(null)
    setApprovalInfo(null)
    setExecutionResult('')
  }

  const runWorkflow = async () => {
    if (!workflowInput.request.trim()) { setNotice('Add a request before running the demonstration.'); return }
    setRunning(true); setWorkflowResult(null); setModelAssessment(null); setRunEvents([]); setPolicyResult(null); setApprovalInfo(null); setExecutionResult(''); setNotice('')
    try {
      const action = selectedAction()
      setActionSnapshot(action)
      if (backendAvailable) {
        const started = await requestApi<{ triage: ReturnType<typeof runTriageWorkflow>; workflow: { id: string; status: string; events: ApiEventView[] }; decision: PolicyView; assessment: GeneratedTriageAssessment; approval?: { id: string; status: ApprovalView['status'] }; result?: { ticket?: { id: string; priority: string }; results?: unknown[] }; executed: boolean }>('/api/workflows', { method: 'POST', body: JSON.stringify({ input: workflowInput, action }) })
        setWorkflowResult(started.triage)
        setModelAssessment(started.assessment)
        setRunEvents(started.workflow.events)
        setPolicyResult(started.decision)
        if (started.decision.outcome === 'ALLOW' && started.executed) {
          setExecutionResult(started.result?.ticket ? `Read ${started.result.ticket.id} (priority: ${started.result.ticket.priority}).` : `Read-only operation completed (${started.result?.results?.length ?? 0} result(s)).`)
          setApprovalInfo({ status: 'executed' })
        } else if (started.decision.outcome === 'REQUIRE_APPROVAL' && started.approval) {
          setApprovalInfo({ id: started.approval.id, status: started.approval.status })
        } else setApprovalInfo({ status: 'blocked' })
      } else {
        const triage = runTriageWorkflow(workflowInput, () => new Date(), { deferFinalEvent: true })
        setWorkflowResult(triage)
        const workflowId = crypto.randomUUID()
        const events: ApiEventView[] = triage.events.map((event) => ({ ...event, workflowId, origin: event.origin }))
        const localDecision: PolicyView = actionMode === 'allow'
          ? { outcome: 'ALLOW', reason: 'Public demo: fictional ticket reads are illustrated as permitted; no backend enforced this decision.' }
          : actionMode === 'block'
            ? { outcome: 'BLOCK', reason: 'Public demo: ticket deletion is illustrated as prohibited; browser state does not enforce server permissions.' }
            : { outcome: 'REQUIRE_APPROVAL', reason: 'Public demo: priority changes are illustrated as requiring human approval; no server approval was created.' }
        events.push({ id: crypto.randomUUID(), workflowId, type: 'policy_evaluated', timestamp: new Date().toISOString(), message: `${localDecision.outcome}: ${localDecision.reason}`, origin: 'browser-demo' })
        if (localDecision.outcome === 'BLOCK') {
          events.push({ id: crypto.randomUUID(), workflowId, type: 'action_blocked', timestamp: new Date().toISOString(), message: 'Illustrative policy blocked this action; it was not executed.', origin: 'browser-demo' })
          events.push({ id: crypto.randomUUID(), workflowId, type: 'workflow_completed', timestamp: new Date().toISOString(), message: 'Browser demo completed after the action was blocked.', origin: 'browser-demo' })
        } else if (localDecision.outcome === 'ALLOW') {
          events.push({ id: crypto.randomUUID(), workflowId, type: 'demo_action_illustrated', timestamp: new Date().toISOString(), message: 'Illustrated read-only result; no server operation ran.', origin: 'browser-demo' })
          events.push({ id: crypto.randomUUID(), workflowId, type: 'workflow_completed', timestamp: new Date().toISOString(), message: 'Browser-only demonstration completed.', origin: 'browser-demo' })
        } else {
          events.push({ id: crypto.randomUUID(), workflowId, type: 'approval_requested', timestamp: new Date().toISOString(), message: 'Illustrative approval request; no server approval record exists.', origin: 'browser-demo' })
        }
        setRunEvents(events)
        setPolicyResult(localDecision)
        setApprovalInfo(actionMode === 'approval' ? { status: 'pending' } : actionMode === 'allow' ? { status: 'demo_only' } : { status: 'blocked' })
        setExecutionResult(actionMode === 'allow' ? 'Illustrative demo result only; no backend operation ran.' : actionMode === 'block' ? 'Not executed in this browser demonstration.' : '')
      }
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const failedRun = error.body.workflow as { events?: ApiEventView[] } | undefined
        if (Array.isArray(failedRun?.events)) setRunEvents(failedRun.events)
        const failedTriage = error.body.triage as ReturnType<typeof runTriageWorkflow> | undefined
        if (failedTriage) setWorkflowResult(failedTriage)
      }
      setNotice(error instanceof Error ? error.message : 'The demonstration workflow could not run.')
    } finally {
      window.setTimeout(() => setRunning(false), 350)
    }
  }

  const resolveApproval = async (outcome: 'approved' | 'rejected') => {
    setNotice('')
    try {
      if (backendAvailable && approvalInfo?.id) {
        const resolved = await requestApi<{ approval: ApprovalView; workflow?: { events: ApiEventView[] } }>('/api/approvals/' + approvalInfo.id + '/decision', { method: 'POST', body: JSON.stringify({ decision: outcome === 'approved' ? 'approve' : 'reject' }) })
        setApprovalInfo(resolved.approval)
        if (resolved.workflow) setRunEvents(resolved.workflow.events)
        if (outcome === 'approved') {
          const executed = await requestApi<{ approval: ApprovalView; result: { ticket?: { id: string; priority: string } }; executed: boolean; workflow?: { events: ApiEventView[] } }>('/api/actions/execute', { method: 'POST', body: JSON.stringify({ approvalId: approvalInfo.id }) })
          setApprovalInfo(executed.approval)
          if (executed.workflow) setRunEvents(executed.workflow.events)
          setExecutionResult(executed.result.ticket ? `Updated ${executed.result.ticket.id} priority to ${executed.result.ticket.priority}.` : 'Approved action executed.')
        } else setExecutionResult('Rejected; no action was executed.')
      } else {
        setApprovalInfo({ status: outcome })
        setExecutionResult(outcome === 'approved' ? 'Public demo preview only; no backend operation ran.' : 'Rejected in the browser demo; no operation ran.')
        const workflowId = runEvents[0]?.workflowId ?? 'browser-demo'
        const event = (type: string, message: string): ApiEventView => ({ id: crypto.randomUUID(), workflowId, type, timestamp: new Date().toISOString(), message, origin: 'browser-demo' })
        const resolutionEvents = outcome === 'rejected'
          ? [event('approval_rejected', 'Approval preview rejected; no operation ran.'), event('workflow_completed', 'Browser demo completed after rejection.')]
          : [event('approval_granted', 'Approval preview granted; no server-side execution occurred.'), event('demo_action_illustrated', 'Approval path illustrated; no operation ran.'), event('workflow_completed', 'Browser-only approval preview completed without execution.')]
        setRunEvents((previous) => [...previous, ...resolutionEvents])
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Approval request failed.')
    }
  }

  const setInput = <K extends keyof WorkflowInput>(key: K, value: WorkflowInput[K]) => {
    setWorkflowInput((previous) => ({ ...previous, [key]: value }))
  }

  const eventRows = runEvents.map((event) => ({
    title: timelineTitles[event.type] ?? event.type.replace(/_/g, ' '),
    source: eventSourceLabel(event.origin, event.type, backendAvailable),
    icon: event.type.includes('blocked') ? ShieldAlert : event.type.includes('approval') ? LockKeyhole : event.type.includes('executed') || event.type === 'workflow_completed' ? Check : event.type.startsWith('tool_') ? Database : event.type === 'decisions_generated' ? BrainCircuit : Shield,
    state: (event.type.includes('blocked') || event.type.includes('rejected')) ? 'blocked' as const : event.type === 'approval_requested' ? 'wait' as const : 'done' as const,
    time: new Date(event.timestamp).toLocaleTimeString('en-GB', { hour12: false }), detail: event.message, key: event.id,
  }))
  const lastRunEvent = runEvents[runEvents.length - 1]
  const runStatusText = running ? 'RUNNING'
    : lastRunEvent?.type === 'workflow_completed' && lastRunEvent.data?.status === 'failed' ? 'FAILED'
      : lastRunEvent?.type === 'workflow_completed' ? 'COMPLETED'
      : lastRunEvent?.type === 'approval_granted' ? 'AWAITING EXECUTION'
        : lastRunEvent?.type === 'approval_requested' ? 'AWAITING APPROVAL'
          : workflowResult ? 'PROCESSING' : 'READY'

  const navItems = [
    { name: 'Overview', icon: LayoutDashboard, target: 'overview' },
    { name: 'Playground', icon: WandSparkles, target: 'playground' },
    { name: 'Decisions', icon: BrainCircuit, target: 'decisions' },
    { name: 'MCP tools', icon: Boxes, target: 'tools' },
    { name: 'Approvals', icon: Shield, target: 'approval' },
  ]

  const navigate = (name: string, target: string) => {
    setActiveNav(name); setMobileNav(false)
    document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="app-shell" id="overview">
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="brand"><div className="brand-mark"><Command size={19} strokeWidth={2.4} /></div><div><strong>agentops</strong><span>PLAYGROUND</span></div></div>
        <div className="workspace-label">WORKSPACE <ChevronDown size={13} /></div>
        <div className="workspace-card"><div className="workspace-avatar">A</div><div><strong>Acme Support</strong><small>Local workspace</small></div><MoreHorizontal size={17} className="muted-icon" /></div>
        <div className="nav-heading">PLATFORM</div>
        <nav aria-label="Main navigation">{navItems.map(({ name, icon: Icon, target }) => <button key={name} className={`nav-item ${activeNav === name ? 'active' : ''}`} onClick={() => navigate(name, target)}><Icon size={17} /><span>{name}</span>{name === 'Approvals' && <b className="nav-count">1</b>}</button>)}</nav>
        <div className="nav-heading workflow-heading">WORKFLOWS</div>
        <button className="nav-item workflow-item" onClick={() => navigate('Playground', 'playground')}><GitBranch size={17} /><span>Support triage</span><span className="live-dot" /></button>
        <button className="nav-item" onClick={() => setNotice('Workflow builder is part of a later phase.')}><Plus size={17} /><span>New workflow</span></button>
        <div className="sidebar-bottom"><div className="local-status"><span className="status-pulse" /><span>Demo environment</span><span className="status-tag">LIVE</span></div><button className="nav-item" onClick={() => setNotice('Settings are illustrative in this demo.')}><Settings2 size={17} /><span>Settings</span></button><div className="profile"><div className="profile-avatar">JD</div><div><strong>Jordan Davis</strong><small>Developer</small></div><MoreHorizontal size={17} className="muted-icon" /></div></div>
      </aside>

      {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
      <main className="main-content">
        <header className="topbar"><button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={19} /></button><div className="breadcrumbs"><span>Workspace</span><span className="crumb-sep">/</span><strong>{activeNav}</strong></div><div className="topbar-right"><div className={`demo-pill ${backendAvailable ? 'api-pill' : ''}`}><span className="status-pulse" /> {backendAvailable ? ollamaStatus?.modelAvailable ? `Local AI · ${ollamaStatus.model}` : 'Local API · AI unavailable' : 'Public demo · browser only'}</div><button className="icon-button search-button" aria-label="Search" onClick={() => setNotice('Search is not connected in demonstration mode.')}><Search size={17} /><kbd>⌘ K</kbd></button><button className="help-button" aria-label="Help" onClick={() => setNotice('AgentOps Playground: Understand. Decide. Act. Safely.')}><CircleHelp size={18} /></button></div></header>

        <div className="page-content">
          {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="Dismiss" onClick={() => setNotice('')}><X size={15} /></button></div>}
          <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR AGENT WORKSPACE</div><h1>Good morning, Jordan <span className="wave">✳</span></h1><p>Understand. Decide. Act. Safely.</p></div><button className="outline-button" onClick={() => setNotice('All metrics shown here come from this demonstration workflow.')}><Clock3 size={15} /> Last 24 hours <ChevronDown size={14} /></button></section>

          <section className="metrics-grid" aria-label="Workflow metrics">
            <Metric icon={Activity} label="Workflows run" value="128" change="12.8%" positive detail="vs. previous period" />
            <Metric icon={BadgeCheck} label="Completed" value="116" change="8.2%" positive detail="90.6% completion rate" />
            <Metric icon={ShieldAlert} label="Need approval" value="09" change="2 pending" detail="across all workflows" />
            <Metric icon={Boxes} label="MCP tool calls" value="342" change="6.4%" positive detail="across 5 available tools" />
          </section>

          <section className="architecture-section" aria-labelledby="architecture-title">
            <div className="architecture-heading">
              <div><div className="eyebrow"><span className="eyebrow-line" /> COMPONENT MAP</div><h2 id="architecture-title">AI Architecture</h2><p>Where each technology operates in the support-triage workflow.</p></div>
              <span className="architecture-mode">{backendAvailable ? 'LOCAL WORKFLOW' : 'BROWSER DEMONSTRATION'}</span>
            </div>
            <div className="architecture-cards">
              <article className="architecture-card arch-ollama"><div className="architecture-card-top"><span className="architecture-icon"><Cpu size={17} /></span><span className="architecture-index">01</span></div><h3>OLLAMA AGENT</h3><span className="architecture-subtitle">REAL LOCAL GENERATIVE AI</span><p>Runs Qwen2.5 1.5B through Ollama to interpret requests, select tools, and use retrieved information to recommend next steps.</p></article>
              <article className="architecture-card arch-decision"><div className="architecture-card-top"><span className="architecture-icon"><BrainCircuit size={17} /></span><span className="architecture-index">02</span></div><h3>TYPESAFE / JEV-INSPIRED DECISION SIMULATION</h3><span className="architecture-subtitle">SIMULATED — NOT THE REAL JEV MODEL</span><p>Deterministic Choice-, Noul-, and Score-inspired outputs demonstrate bounded typed decisions. No TypeSafe AI or Jev model is connected.</p></article>
              <article className="architecture-card arch-mcp"><div className="architecture-card-top"><span className="architecture-icon"><Server size={17} /></span><span className="architecture-index">03</span></div><h3>MCP TOOL INTEGRATION</h3><span className="architecture-subtitle">{backendAvailable ? 'REAL MCP CLIENT + SERVER' : 'MCP DEMO — SIMULATED'}</span><p>{backendAvailable ? 'Discovers tools through the client and invokes them over MCP to retrieve fictional ticket and knowledge-base data or perform authorised demo operations.' : 'Illustrates tool discovery and calls with fictional data. This browser demo is not connected to the local MCP server.'}</p></article>
              <article className="architecture-card arch-policy"><div className="architecture-card-top"><span className="architecture-icon"><Shield size={17} /></span><span className="architecture-index">04</span></div><h3>DETERMINISTIC POLICY ENGINE</h3><span className="architecture-subtitle">APPLICATION-ENFORCED SAFETY</span><p>Evaluates proposed operations as ALLOW, BLOCK, or REQUIRE_APPROVAL. Backend policy is independent of model output and prevents unapproved execution.</p></article>
            </div>
            <div className="architecture-flow-wrap">
              <div className="architecture-flow-heading"><strong>Conceptual workflow</strong><span>Conceptual order only; runtime sequence can differ. The timeline below shows actual run events.</span></div>
              <div className="architecture-flow" aria-label="Conceptual flow: User request, Ollama Agent, Jev-inspired Decision Simulation, MCP Client and Server, Ollama assessment, Deterministic Policy Engine, Human Approval if required, Authorised execution">
                {['User request', 'Ollama Agent', 'Decision simulation', 'MCP Client + Server', 'Ollama assessment', 'Policy engine', 'Human approval · if required', 'Authorised execution'].map((step, index) => <div className="architecture-flow-step" key={step}><span className={`flow-number flow-tone-${index % 4}`}>{index + 1}</span><span>{step}</span>{index < 7 && <ArrowRight className="flow-arrow" size={13} aria-hidden="true" />}</div>)}
              </div>
            </div>
            <div className="architecture-legend" aria-label="Technology legend"><strong>Legend</strong><span><i className="legend-mark real" />Real local AI</span><span><i className="legend-mark simulated" />Simulated typed decisions</span><span><i className="legend-mark mcp" />Actual MCP operations in local mode</span><span><i className="legend-mark policy" />Deterministic policy decisions</span><small>Jev-inspired decisions are a project simulation and are not connected to the actual Jev model.</small></div>
          </section>

          <div className="section-title-row"><div><h2>Agent playground</h2><p>Run a support scenario and inspect each step.</p></div><span className="demo-label"><span className="demo-dot" /> {backendAvailable ? 'LOCAL API · POLICY ENFORCED' : 'BROWSER DEMO · NOT SERVER ENFORCED'}</span></div>

          <section className="playground-grid" id="playground">
            <article className="panel request-panel"><div className="panel-heading"><div className="panel-title-icon purple"><Sparkles size={16} /></div><div><h3>Try a scenario</h3><p>Give your agent a task to work through</p></div><button className="small-more" aria-label="More options"><MoreHorizontal size={18} /></button></div>
              <label className="field-label" htmlFor="scenario-select">SCENARIO</label><div className="select-wrap"><select id="scenario-select" value={scenarioIndex} disabled={approvalPending} onChange={(event) => pickScenario(Number(event.target.value))}>{scenarios.map((scenario, index) => <option value={index} key={scenario.label}>{scenario.label}</option>)}</select><ChevronDown size={15} /></div>
              <label className="field-label request-label" htmlFor="request">YOUR REQUEST</label><textarea id="request" value={workflowInput.request} onChange={(event) => setInput('request', event.target.value)} rows={4} maxLength={500} disabled={approvalPending} />
              <div className="input-controls"><label>Issue type<select value={workflowInput.issueType} disabled={approvalPending} onChange={(event) => setInput('issueType', event.target.value as WorkflowInput['issueType'])}><option value="refund">Refund</option><option value="account_access">Account access</option><option value="damaged_delivery">Damaged delivery</option><option value="general">General inquiry</option></select></label><label>Customer impact<select value={workflowInput.customerImpact} disabled={approvalPending} onChange={(event) => setInput('customerImpact', event.target.value as WorkflowInput['customerImpact'])}><option value="single_customer">One customer</option><option value="multiple_customers">Multiple customers</option><option value="business_blocking">Business blocked</option></select></label><label>Days waiting<input type="number" min="0" max="60" value={workflowInput.daysWaiting} disabled={approvalPending} onChange={(event) => setInput('daysWaiting', Number(event.target.value))} /></label></div>
              <label className="field-label action-label" htmlFor="action-mode">ACTION TO DEMONSTRATE</label><div className="select-wrap"><select id="action-mode" value={actionMode} disabled={approvalPending} onChange={(event) => setActionMode(event.target.value as DemoActionMode)}><option value="allow">Read existing ticket · ALLOW</option><option value="approval">Change ticket priority · REQUIRE APPROVAL</option><option value="block">Delete ticket · BLOCK</option></select><ChevronDown size={15} /></div>
              <div className="request-footer"><span><span className="sim-indicator" /> Deterministic demo · simulated decisions only</span><span>{workflowInput.request.length} / 500</span></div>
              <button className="run-button" onClick={() => void runWorkflow()} disabled={running || approvalPending}>{running ? <><span className="button-spinner" /> Running workflow…</> : approvalPending ? <>Resolve the pending approval</> : <><Play size={15} fill="currentColor" /> Run workflow <span className="button-shortcut">⌘ ↵</span></>}</button>
              <div className="workflow-mini"><div className="mini-step"><span className="mini-icon icon-ai"><Sparkles size={13} /></span><span>Ollama agent</span></div><span className="mini-connector" /><div className="mini-step"><span className="mini-icon icon-decide"><BrainCircuit size={13} /></span><span>Jev simulation</span></div><span className="mini-connector" /><div className="mini-step"><span className="mini-icon icon-tool"><Database size={13} /></span><span>MCP tools</span></div><span className="mini-connector" /><div className="mini-step"><span className="mini-icon icon-policy"><Shield size={13} /></span><span>Policy engine</span></div></div>
            </article>

            <article className="panel timeline-panel" id="timeline"><div className="panel-heading timeline-heading"><div><h3>Execution timeline</h3><p>Observable events from the latest run</p></div><div className="run-status"><span className="status-pulse" /> {runStatusText}</div></div>
              {eventRows.length ? <div className="timeline">{eventRows.map((event, index) => <div className={`timeline-event ${event.state}`} key={event.key}><div className="timeline-rail"><div className={`event-icon ${event.state}`}><event.icon size={14} /></div>{index < eventRows.length - 1 && <span className="rail-line" />}</div><div className="event-copy"><div className="event-top"><strong>{event.title}</strong><time>{event.time}</time></div><p>{event.detail}</p><span className={`source-tag source-${event.source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`}>{event.source}</span></div></div>)}</div> : <div className="timeline-empty"><Activity size={17} /><span>Run the workflow to generate observable events.</span></div>}
              <button className="view-events" onClick={() => setNotice(backendAvailable ? 'Timeline sources reflect the local workflow, including actual Ollama and MCP events.' : 'Browser timeline entries are simulated; no Ollama or local MCP calls occurred.')}>Event origins are labeled <ArrowDownRight size={14} /></button>
            </article>
          </section>

          <div className="lower-grid">
            <section className="panel decisions-panel" id="decisions"><div className="panel-heading"><div><h3>Decision inspector</h3><p>Bounded outputs with visible sources</p></div><span className="sim-badge"><span className="sim-indicator" /> SIMULATED</span></div>
              <div className="decision-rows"><DecisionRow icon={BrainCircuit} type="CHOICE · DEPARTMENT" value={previewDecisions.department.value.replace(/_/g, ' ')} source="Jev-inspired simulation" tone="violet" /><DecisionRow icon={Activity} type="NOUL · URGENCY" value={previewDecisions.urgency.value ? 'Urgent' : 'Normal'} source="Jev-inspired simulation" tone="amber" /><DecisionRow icon={Gauge} type="SCORE · SEVERITY" value={<>{previewDecisions.severity.value}<span className="score-max"> / {previewDecisions.severity.scale.max}</span></>} source="Jev-inspired simulation" tone="blue" /></div>
              <div className="recommendation"><div className="recommend-icon"><Sparkles size={15} /></div><div className="assessment-copy"><span>{modelAssessment ? `OLLAMA · ${modelAssessment.model} · GENERATED LOCALLY` : backendAvailable ? 'LOCAL MODEL ASSESSMENT' : 'BROWSER DEMO · DETERMINISTIC'}</span>{modelAssessment ? <><p><b>Summary</b> {modelAssessment.summary}</p><p><b>Recommendation</b> {modelAssessment.recommendation}</p><p><b>Explanation</b> {modelAssessment.explanation}</p>{modelAssessment.needsClarification && <p className="clarifying-question"><b>Clarification needed</b> {modelAssessment.clarifyingQuestion}</p>}<small>Generated by local Ollama inference · policy and typed decisions are separate</small></> : backendAvailable ? <><p>{runEvents.some((event) => event.type === 'ollama_error') ? 'The local model did not return an assessment. See the workflow error above.' : 'Run the workflow to request an assessment from the local model.'}</p><small>{ollamaStatus?.message ?? 'No generated result is being shown.'}</small></> : <><p>{workflowResult?.recommendation ?? 'Run the browser demonstration for a deterministic triage recommendation.'}</p><small>Browser demonstration only · not generated by Ollama</small></>}</div></div>
            </section>

            <section className="panel tools-panel" id="tools"><div className="panel-heading"><div><h3>MCP tool explorer</h3><p>{mcpConnected ? 'Tool definitions discovered from the local server' : 'Demonstration definitions · no local MCP connection'}</p></div><button className="text-button" onClick={() => setNotice(mcpConnected ? `Discovered ${mcpTools.length} tools over the local MCP protocol.` : 'Browser demo tool definitions are illustrative only.')}>Explore tools <ArrowUpRight size={14} /></button></div>
              <div className="tool-list">{(mcpConnected ? mcpTools : demoMcpTools).map((tool) => <ToolRow key={tool.name} name={tool.name} description={tool.description ?? 'MCP tool'} access={tool.annotations?.readOnlyHint === false ? 'WRITE · POLICY' : 'READ'} schema={tool.inputSchema} />)}</div>
              <div className="mcp-foot"><span className="mcp-mark">M</span><span>{mcpConnected ? 'Actual MCP client · stdio transport' : 'Illustrative MCP definitions'}</span><span className="tool-foot-right">{(mcpConnected ? mcpTools : demoMcpTools).length} tools <ArrowUpRight size={12} /></span></div>
            </section>
          </div>

          <section className="panel approval-panel" id="approval"><div className="approval-left"><div className="approval-shield"><LockKeyhole size={18} /></div><div><div className="approval-kicker"><span className="approval-dot" /> {backendAvailable ? 'BACKEND POLICY DECISION' : 'BROWSER DEMO · ILLUSTRATIVE POLICY'} <span className="approval-id">{approvalInfo?.id ? `ID · ${approvalInfo.id.slice(0, 8)}` : 'NO SERVER APPROVAL ID'}</span></div><h3>Proposed action review</h3><p>Action for fictional ticket <strong>{workflowInput.ticketId}</strong>.</p></div></div><div className="approval-detail"><div className="approval-action"><div><span>PROPOSED ACTION</span><strong>{actionDescription}</strong><small><Shield size={12} /> {backendAvailable ? 'Revalidated by Express before execution' : 'Illustrative result; browser does not enforce permissions'}</small></div>{policyResult && <span className={`policy-outcome ${policyResult.outcome.toLowerCase()}`}>{policyResult.outcome}</span>}</div>{policyResult && <div className="policy-reason"><strong>Policy reason</strong><span>{policyResult.reason}</span>{executionResult && <small>{executionResult}</small>}{approvalInfo && <small>Approval status: {approvalInfo.status.toUpperCase()} · {approvalInfo.status === 'executed' && backendAvailable ? 'backend execution occurred' : approvalInfo.status === 'demo_only' ? 'no backend execution occurred' : 'no execution occurred'}</small>}</div>}{policyResult?.outcome === 'REQUIRE_APPROVAL' && approvalInfo?.status === 'pending' && <div className="approval-buttons"><button className="reject-button" onClick={() => void resolveApproval('rejected')}>Reject action</button><button className="approve-button" onClick={() => void resolveApproval('approved')}><Check size={14} /> {backendAvailable ? 'Approve & execute' : 'Preview approval'}</button></div>}{policyResult?.outcome === 'BLOCK' && <div className="blocked-note"><ShieldAlert size={14} /> This operation cannot execute, even if approved.</div>}</div></section>

          <footer className="page-footer"><div><span className="footer-mark"><Command size={13} /></span><span>AgentOps Playground</span><span className="footer-sep">·</span><span>Understand. Decide. Act. Safely.</span></div><div><span className="footer-demo-dot" /> Public demo <span className="footer-sep">·</span><button onClick={() => setNotice('This portfolio demo uses fictional data only.')}>About this demo <ArrowUpRight size={12} /></button></div></footer>
        </div>
      </main>
    </div>
  )
}

function Metric({ icon: Icon, label, value, change, positive, detail }: { icon: typeof Activity; label: string; value: string; change: string; positive?: boolean; detail: string }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><Icon size={16} /></div><div className="metric-value">{value}</div><div className="metric-foot">{positive && <span className="metric-change"><ArrowUpRight size={12} />{change}</span>}{!positive && <span className="metric-neutral">{change}</span>}<span>{detail}</span></div></article>
}

async function requestApi<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new ApiRequestError(body.error ?? `API request failed (${response.status}).`, response.status, body as Record<string, unknown>)
  return body
}

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

function DecisionRow({ icon: Icon, type, value, source, tone }: { icon: typeof Activity; type: string; value: React.ReactNode; source: string; tone: string }) {
  return <div className="decision-row"><div className={`decision-icon ${tone}`}><Icon size={15} /></div><div className="decision-main"><span>{type}</span><strong>{value}</strong></div><div className="decision-source"><span className="origin-dot" />{source}</div></div>
}

function ToolRow({ name, description, access, schema }: { name: string; description: string; access: string; schema: Record<string, unknown> }) {
  return <div className="tool-row"><div className="tool-code-icon"><FileText size={14} /></div><div className="tool-info"><strong>{name}</strong><span>{description}</span><details><summary>Input schema</summary><code>{JSON.stringify(schema)}</code></details></div><span className={`access-tag ${access.toLowerCase().startsWith('write') ? 'approval' : 'read'}`}>{access}</span></div>
}

export default App
