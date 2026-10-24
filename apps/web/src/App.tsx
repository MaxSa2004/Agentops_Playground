import { useState } from 'react'
import {
  Activity, ArrowDownRight, ArrowUpRight, BadgeCheck, Boxes, BrainCircuit,
  Check, ChevronDown, CircleHelp, Clock3, Command, Database, FileText, Gauge,
  GitBranch, LayoutDashboard, LockKeyhole, Menu, MessageSquareText, MoreHorizontal,
  Play, Plus, Search, Settings2, Shield, ShieldAlert, Sparkles, WandSparkles,
  X,
} from 'lucide-react'

type EventItem = { time: string; title: string; detail: string; source: string; state: 'done' | 'wait' | 'blocked'; icon: typeof Activity }

const initialEvents: EventItem[] = [
  { time: '10:42:08', title: 'Request received', detail: 'Refund request · ticket #TK-2048', source: 'WORKFLOW', state: 'done', icon: MessageSquareText },
  { time: '10:42:09', title: 'Request interpreted', detail: 'Customer asks for a refund after a delayed delivery.', source: 'DEMO AI', state: 'done', icon: Sparkles },
  { time: '10:42:09', title: 'Typed decisions generated', detail: 'Billing · Urgent · Severity 2 / 3', source: 'SIMULATOR', state: 'done', icon: BrainCircuit },
  { time: '10:42:10', title: 'Ticket retrieved', detail: 'get_ticket({ id: "TK-2048" })', source: 'DEMO MCP', state: 'done', icon: Database },
  { time: '10:42:10', title: 'Policy requires approval', detail: 'Changing priority needs human review.', source: 'POLICY', state: 'wait', icon: ShieldAlert },
]

const scenarios = [
  { label: 'Refund request', ticket: 'TK-2048', request: 'Analyse this customer’s refund request, retrieve the support ticket, determine urgency, and recommend the next action.', department: 'Billing', urgency: 'Urgent', severity: 2, action: 'Raise ticket priority to High' },
  { label: 'Login issue', ticket: 'TK-1982', request: 'A customer cannot access their account after resetting their password. Find the ticket and recommend a safe next step.', department: 'Technical support', urgency: 'Normal', severity: 1, action: 'Send account recovery instructions' },
  { label: 'Damaged delivery', ticket: 'TK-2116', request: 'Review the damaged delivery complaint and determine the right team and recommended action.', department: 'Shipping', urgency: 'Urgent', severity: 3, action: 'Escalate to the shipping team' },
]

function App() {
  const [scenarioIndex, setScenarioIndex] = useState(0)
  const [request, setRequest] = useState(scenarios[0].request)
  const [events, setEvents] = useState(initialEvents)
  const [running, setRunning] = useState(false)
  const [decision, setDecision] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const [activeNav, setActiveNav] = useState('Overview')
  const [mobileNav, setMobileNav] = useState(false)
  const [notice, setNotice] = useState('')
  const current = scenarios[scenarioIndex]

  const pickScenario = (index: number) => {
    setScenarioIndex(index)
    setRequest(scenarios[index].request)
    setDecision('pending')
    setEvents(initialEvents.map((event, i) => i === 0 ? { ...event, detail: `${scenarios[index].label} · ticket #${scenarios[index].ticket}` } : event))
  }

  const runWorkflow = () => {
    if (!request.trim()) { setNotice('Add a request before running the demonstration.'); return }
    setRunning(true); setDecision('pending'); setNotice('')
    const now = new Date().toLocaleTimeString('en-GB', { hour12: false })
    setEvents([
      { ...initialEvents[0], time: now, detail: `${current.label} · ticket #${current.ticket}` },
      ...initialEvents.slice(1),
    ])
    window.setTimeout(() => setRunning(false), 650)
  }

  const resolveApproval = (outcome: 'approved' | 'rejected') => {
    setDecision(outcome)
    setEvents((previous) => [...previous, {
      time: new Date().toLocaleTimeString('en-GB', { hour12: false }),
      title: outcome === 'approved' ? 'Action approved and executed' : 'Action rejected',
      detail: outcome === 'approved' ? `${current.action} · demonstration dataset` : 'No changes were made to the demonstration ticket.',
      source: outcome === 'approved' ? 'HUMAN + DEMO' : 'HUMAN', state: outcome === 'approved' ? 'done' : 'blocked', icon: outcome === 'approved' ? Check : X,
    }])
  }

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
        <header className="topbar"><button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={19} /></button><div className="breadcrumbs"><span>Workspace</span><span className="crumb-sep">/</span><strong>{activeNav}</strong></div><div className="topbar-right"><div className="demo-pill"><span className="status-pulse" /> Demonstration mode</div><button className="icon-button search-button" aria-label="Search" onClick={() => setNotice('Search is not connected in demonstration mode.')}><Search size={17} /><kbd>⌘ K</kbd></button><button className="help-button" aria-label="Help" onClick={() => setNotice('AgentOps Playground: Understand. Decide. Act. Safely.')}><CircleHelp size={18} /></button></div></header>

        <div className="page-content">
          {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="Dismiss" onClick={() => setNotice('')}><X size={15} /></button></div>}
          <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR AGENT WORKSPACE</div><h1>Good morning, Jordan <span className="wave">✳</span></h1><p>Understand. Decide. Act. Safely.</p></div><button className="outline-button" onClick={() => setNotice('All metrics shown here come from this demonstration workflow.')}><Clock3 size={15} /> Last 24 hours <ChevronDown size={14} /></button></section>

          <section className="metrics-grid" aria-label="Workflow metrics">
            <Metric icon={Activity} label="Workflows run" value="128" change="12.8%" positive detail="vs. previous period" />
            <Metric icon={BadgeCheck} label="Completed" value="116" change="8.2%" positive detail="90.6% completion rate" />
            <Metric icon={ShieldAlert} label="Need approval" value="09" change="2 pending" detail="across all workflows" />
            <Metric icon={Boxes} label="MCP tool calls" value="342" change="6.4%" positive detail="across 5 available tools" />
          </section>

          <div className="section-title-row"><div><h2>Agent playground</h2><p>Run a support scenario and inspect each step.</p></div><span className="demo-label"><span className="demo-dot" /> DEMONSTRATION DATA</span></div>

          <section className="playground-grid" id="playground">
            <article className="panel request-panel"><div className="panel-heading"><div className="panel-title-icon purple"><Sparkles size={16} /></div><div><h3>Try a scenario</h3><p>Give your agent a task to work through</p></div><button className="small-more" aria-label="More options"><MoreHorizontal size={18} /></button></div>
              <label className="field-label" htmlFor="scenario-select">SCENARIO</label><div className="select-wrap"><select id="scenario-select" value={scenarioIndex} onChange={(event) => pickScenario(Number(event.target.value))}>{scenarios.map((scenario, index) => <option value={index} key={scenario.label}>{scenario.label}</option>)}</select><ChevronDown size={15} /></div>
              <label className="field-label request-label" htmlFor="request">YOUR REQUEST</label><textarea id="request" value={request} onChange={(event) => setRequest(event.target.value)} rows={4} />
              <div className="request-footer"><span><span className="sim-indicator" /> Deterministic demo · no live AI</span><span>{request.length} / 500</span></div>
              <button className="run-button" onClick={runWorkflow} disabled={running}>{running ? <><span className="button-spinner" /> Running workflow…</> : <><Play size={15} fill="currentColor" /> Run workflow <span className="button-shortcut">⌘ ↵</span></>}</button>
              <div className="workflow-mini"><div className="mini-step"><span className="mini-icon icon-ai"><Sparkles size={13} /></span><span>Interpret request</span></div><span className="mini-connector" /><div className="mini-step"><span className="mini-icon icon-decide"><BrainCircuit size={13} /></span><span>Typed decisions</span></div><span className="mini-connector" /><div className="mini-step"><span className="mini-icon icon-tool"><Database size={13} /></span><span>Retrieve ticket</span></div><span className="mini-connector" /><div className="mini-step"><span className="mini-icon icon-policy"><Shield size={13} /></span><span>Check policy</span></div></div>
            </article>

            <article className="panel timeline-panel" id="timeline"><div className="panel-heading timeline-heading"><div><h3>Execution timeline</h3><p>Observable events from the latest run</p></div><div className="run-status"><span className="status-pulse" /> {running ? 'RUNNING' : 'COMPLETED'}</div></div>
              <div className="timeline">{events.map((event, index) => <div className={`timeline-event ${event.state}`} key={`${event.title}-${index}`}><div className="timeline-rail"><div className={`event-icon ${event.state}`}><event.icon size={14} /></div>{index < events.length - 1 && <span className="rail-line" />}</div><div className="event-copy"><div className="event-top"><strong>{event.title}</strong><time>{event.time}</time></div><p>{event.detail}</p><span className={`source-tag source-${event.source.toLowerCase().replace(/ /g, '-')}`}>{event.source}</span></div></div>)}</div>
              <button className="view-events" onClick={() => setNotice('You are viewing all events in this demonstration run.')}>View all events <ArrowDownRight size={14} /></button>
            </article>
          </section>

          <div className="lower-grid">
            <section className="panel decisions-panel" id="decisions"><div className="panel-heading"><div><h3>Decision inspector</h3><p>Bounded outputs with visible sources</p></div><span className="sim-badge"><span className="sim-indicator" /> SIMULATED</span></div>
              <div className="decision-rows"><DecisionRow icon={BrainCircuit} type="CHOICE · DEPARTMENT" value={current.department} source="decision-simulator" tone="violet" /><DecisionRow icon={Activity} type="NOUL · URGENCY" value={current.urgency} source="decision-simulator" tone="amber" /><DecisionRow icon={Gauge} type="SCORE · SEVERITY" value={<>{current.severity}<span className="score-max"> / 3</span></>} source="decision-simulator" tone="blue" /></div>
              <div className="recommendation"><div className="recommend-icon"><Sparkles size={15} /></div><div><span>DEMO RECOMMENDATION</span><p>Review the delivery history, then offer a refund in line with the late-delivery policy.</p><small>Illustrative generated output · not live AI</small></div></div>
            </section>

            <section className="panel tools-panel" id="tools"><div className="panel-heading"><div><h3>MCP tool explorer</h3><p>Available tools in this workflow</p></div><button className="text-button" onClick={() => setNotice('Tool schemas will be available when the real MCP server is added in a later phase.')}>Explore tools <ArrowUpRight size={14} /></button></div>
              <div className="tool-list"><ToolRow name="get_ticket" description="Retrieve a support ticket by ID" access="READ" /><ToolRow name="search_knowledge_base" description="Search support documentation" access="READ" /><ToolRow name="update_ticket_priority" description="Change a ticket priority" access="APPROVAL" /></div>
              <div className="mcp-foot"><span className="mcp-mark">M</span><span>Illustrative MCP tools</span><span className="tool-foot-right">5 tools available <ArrowUpRight size={12} /></span></div>
            </section>
          </div>

          <section className="panel approval-panel" id="approval"><div className="approval-left"><div className="approval-shield"><LockKeyhole size={18} /></div><div><div className="approval-kicker"><span className="approval-dot" /> HUMAN APPROVAL REQUIRED <span className="approval-id">PENDING · AP-0084</span></div><h3>Review proposed action</h3><p>The agent recommends changing priority for <strong>{current.ticket}</strong>.</p></div></div><div className="approval-action"><div><span>PROPOSED ACTION</span><strong>{current.action}</strong><small><Shield size={12} /> Policy: approval required</small></div>{decision === 'pending' ? <div className="approval-buttons"><button className="reject-button" onClick={() => resolveApproval('rejected')}>Reject</button><button className="approve-button" onClick={() => resolveApproval('approved')}><Check size={14} /> Approve action</button></div> : <div className={`resolved-badge ${decision}`}><Check size={14} /> {decision === 'approved' ? 'Approved · demo executed' : 'Rejected · no changes'}</div>}</div></section>

          <footer className="page-footer"><div><span className="footer-mark"><Command size={13} /></span><span>AgentOps Playground</span><span className="footer-sep">·</span><span>Understand. Decide. Act. Safely.</span></div><div><span className="footer-demo-dot" /> Public demo <span className="footer-sep">·</span><button onClick={() => setNotice('This portfolio demo uses fictional data only.')}>About this demo <ArrowUpRight size={12} /></button></div></footer>
        </div>
      </main>
    </div>
  )
}

function Metric({ icon: Icon, label, value, change, positive, detail }: { icon: typeof Activity; label: string; value: string; change: string; positive?: boolean; detail: string }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><Icon size={16} /></div><div className="metric-value">{value}</div><div className="metric-foot">{positive && <span className="metric-change"><ArrowUpRight size={12} />{change}</span>}{!positive && <span className="metric-neutral">{change}</span>}<span>{detail}</span></div></article>
}

function DecisionRow({ icon: Icon, type, value, source, tone }: { icon: typeof Activity; type: string; value: React.ReactNode; source: string; tone: string }) {
  return <div className="decision-row"><div className={`decision-icon ${tone}`}><Icon size={15} /></div><div className="decision-main"><span>{type}</span><strong>{value}</strong></div><div className="decision-source"><span className="origin-dot" />{source}</div></div>
}

function ToolRow({ name, description, access }: { name: string; description: string; access: string }) {
  return <div className="tool-row"><div className="tool-code-icon"><FileText size={14} /></div><div className="tool-info"><strong>{name}</strong><span>{description}</span></div><span className={`access-tag ${access.toLowerCase()}`}>{access}</span></div>
}

export default App
