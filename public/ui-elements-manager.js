// UI Elements Manager - Dynamic Interface
let allElements = [];
let filteredElements = [];
let currentFilter = 'all';
let sortColumn = 'sort_order';
let sortDirection = 'asc';
let editingElementId = null;
let deleteElementId = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadElements();
  setupEventListeners();
});

function setupEventListeners() {
  // Search
  document.getElementById('searchInput').addEventListener('input', (e) => {
    filterAndRender();
  });

  // Form validation
  document.getElementById('elementId').addEventListener('input', (e) => {
    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, '');
  });
}

// Load elements from API
async function loadElements() {
  try {
    const response = await fetch('/api/ui-element-catalog', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });

    if (!response.ok) throw new Error('Failed to load elements');

    const data = await response.json();
    allElements = data.map(item => ({
      element_id: item.id || item.ELEMENT_ID,
      field: item.field || item.FIELD,
      label: item.label || item.LABEL,
      sort_order: item.sortOrder || item.SORT_ORDER || 999
    }));

    filteredElements = [...allElements];
    renderFilterButtons();
    updateStats();
    sortAndRender();
  } catch (error) {
    console.error('Error loading elements:', error);
    showToast('Failed to load UI elements', 'error');
    document.getElementById('tableBody').innerHTML = `
      <tr><td colspan="5">
        <div class="empty-state">
          <div class="empty-state-icon">⚠️</div>
          <h3>Failed to load elements</h3>
          <p>${error.message}</p>
        </div>
      </td></tr>
    `;
  }
}

// Render filter buttons
function renderFilterButtons() {
  const categories = ['all', ...new Set(allElements.map(e => e.field))].sort();
  const container = document.getElementById('filterButtons');
  
  container.innerHTML = categories.map(cat => `
    <button 
      class="filter-btn ${currentFilter === cat ? 'active' : ''}"
      onclick="setFilter('${cat}')"
    >
      ${cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
    </button>
  `).join('');
}

// Set filter
function setFilter(category) {
  currentFilter = category;
  renderFilterButtons();
  filterAndRender();
}

// Filter and render
function filterAndRender() {
  const searchTerm = document.getElementById('searchInput').value.toLowerCase();
  
  filteredElements = allElements.filter(element => {
    const matchesFilter = currentFilter === 'all' || element.field === currentFilter;
    const matchesSearch = 
      element.element_id.toLowerCase().includes(searchTerm) ||
      element.field.toLowerCase().includes(searchTerm) ||
      element.label.toLowerCase().includes(searchTerm);
    
    return matchesFilter && matchesSearch;
  });

  sortAndRender();
}

// Sort table
function sortTable(column) {
  if (sortColumn === column) {
    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    sortColumn = column;
    sortDirection = 'asc';
  }
  sortAndRender();
}

// Sort and render table
function sortAndRender() {
  filteredElements.sort((a, b) => {
    let aVal = a[sortColumn];
    let bVal = b[sortColumn];
    
    if (sortColumn === 'sort_order') {
      aVal = parseInt(aVal) || 999;
      bVal = parseInt(bVal) || 999;
    } else {
      aVal = String(aVal).toLowerCase();
      bVal = String(bVal).toLowerCase();
    }
    
    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  });

  renderTable();
}

// Render table
function renderTable() {
  const tbody = document.getElementById('tableBody');
  
  if (filteredElements.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="5">
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <h3>No elements found</h3>
          <p>Try adjusting your search or filter</p>
        </div>
      </td></tr>
    `;
    return;
  }

  tbody.innerHTML = filteredElements.map(element => `
    <tr>
      <td><code class="element-id">${escapeHtml(element.element_id)}</code></td>
      <td><span class="field-badge field-${element.field}">${escapeHtml(element.field)}</span></td>
      <td>${escapeHtml(element.label)}</td>
      <td>${element.sort_order}</td>
      <td>
        <div class="actions">
          <button class="btn btn-secondary btn-sm" onclick="openEditModal('${escapeHtml(element.element_id)}')">
            ✏️ Edit
          </button>
          <button class="btn btn-danger btn-sm" onclick="openDeleteModal('${escapeHtml(element.element_id)}')">
            🗑️ Delete
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

// Update stats
function updateStats() {
  document.getElementById('totalCount').textContent = allElements.length;
  document.getElementById('categoryCount').textContent = new Set(allElements.map(e => e.field)).size;
}

// Open add modal
function openAddModal() {
  editingElementId = null;
  document.getElementById('modalTitle').textContent = 'Add UI Element';
  document.getElementById('saveButtonText').textContent = 'Save Element';
  document.getElementById('elementForm').reset();
  document.getElementById('elementId').disabled = false;
  document.getElementById('elementModal').classList.add('active');
}

// Open edit modal
function openEditModal(elementId) {
  const element = allElements.find(e => e.element_id === elementId);
  if (!element) return;

  editingElementId = elementId;
  document.getElementById('modalTitle').textContent = 'Edit UI Element';
  document.getElementById('saveButtonText').textContent = 'Update Element';
  
  document.getElementById('elementId').value = element.element_id;
  document.getElementById('elementId').disabled = true;
  document.getElementById('field').value = element.field;
  document.getElementById('label').value = element.label;
  document.getElementById('sortOrder').value = element.sort_order;
  
  document.getElementById('elementModal').classList.add('active');
}

// Close modal
function closeModal() {
  document.getElementById('elementModal').classList.remove('active');
  editingElementId = null;
}

// Save element
async function saveElement() {
  const form = document.getElementById('elementForm');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const elementId = document.getElementById('elementId').value.trim();
  const field = document.getElementById('field').value;
  const label = document.getElementById('label').value.trim();
  const sortOrder = parseInt(document.getElementById('sortOrder').value);

  const payload = {
    id: elementId,
    field: field,
    label: label,
    sortOrder: sortOrder
  };

  try {
    const response = await fetch('/api/ui-element-catalog', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to save element');
    }

    showToast(
      editingElementId ? 'Element updated successfully' : 'Element added successfully',
      'success'
    );
    
    closeModal();
    loadElements(); // Reload to get fresh data
  } catch (error) {
    console.error('Error saving element:', error);
    showToast(error.message, 'error');
  }
}

// Open delete modal
function openDeleteModal(elementId) {
  deleteElementId = elementId;
  document.getElementById('deleteElementId').textContent = elementId;
  document.getElementById('deleteModal').classList.add('active');
}

// Close delete modal
function closeDeleteModal() {
  document.getElementById('deleteModal').classList.remove('active');
  deleteElementId = null;
}

// Confirm delete
async function confirmDelete() {
  if (!deleteElementId) return;

  try {
    const response = await fetch(`/api/ui-element-catalog/${deleteElementId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete element');
    }

    showToast('Element deleted successfully', 'success');
    closeDeleteModal();
    loadElements(); // Reload to get fresh data
  } catch (error) {
    console.error('Error deleting element:', error);
    showToast(error.message, 'error');
  }
}

// Export to CSV
function exportToCSV() {
  const headers = ['Element ID', 'Field', 'Label', 'Sort Order'];
  const rows = filteredElements.map(e => [
    e.element_id,
    e.field,
    e.label,
    e.sort_order
  ]);

  const csv = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ui-elements-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  showToast('CSV exported successfully', 'success');
}

// Show toast notification
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✅' : '❌'}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Close modal on outside click
document.getElementById('elementModal').addEventListener('click', (e) => {
  if (e.target.id === 'elementModal') closeModal();
});

document.getElementById('deleteModal').addEventListener('click', (e) => {
  if (e.target.id === 'deleteModal') closeDeleteModal();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeDeleteModal();
  }
  if (e.key === 'n' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    openAddModal();
  }
});
