import sys

with open("admin-ui/src/App.jsx", "r") as f:
    content = f.read()

# 1. Replace nav.tabs
nav_start = content.find('<nav className="tabs">')
nav_end = content.find('</nav>', nav_start) + len('</nav>')

replacement = """<div className="tabs-header">
        {categories.map((cat) => (
          <TabButton 
            key={cat.id} 
            active={currentCategory.id === cat.id} 
            onClick={() => setActiveTab(cat.tabs[0].id)}
          >
            {cat.label}
          </TabButton>
        ))}
      </div>

      <div className="layout-main-split">
        <aside className="left-nav">
          {currentCategory.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`nav-item ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </aside>

        <main className="tab-content">"""

content = content[:nav_start] + replacement + content[nav_end:]

# 2. Add closing tags before last </div>
last_div = content.rfind('</div>')
content = content[:last_div] + '        </main>\n      </div>\n    ' + content[last_div:]

with open("admin-ui/src/App.jsx", "w") as f:
    f.write(content)
