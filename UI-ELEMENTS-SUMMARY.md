# Complete UI Element Catalog - Summary

## Overview
This document lists all **68 UI elements** found in your Modbus monitoring application codebase.

**Previously saved:** 23 elements  
**Newly added:** 45 elements  
**Total now:** 68 elements

---

## UI Elements by Category

### 🔐 AUTHENTICATION (3 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `auth.login` | Login form | 1 |
| `auth.logout` | Logout button | 2 |
| `auth.change_password` | Change own password | 3 |

### 🚨 ALARMS (7 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `alarm.mute` | Mute alarm sound button | 10 |
| `alarm.acknowledge` | Acknowledge alarm | 11 |
| `alarm.reset` | Reset / clear active alarm | 12 |
| `alarm.view_events` | View events / alarms log | 13 |
| `alarm.read` | View alarms | 14 |
| `alarm.snooze` | Snooze alarm button | 15 |
| `alarm.Accept` | Accept alarm | 999 |

### 🔧 DEVICES (10 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `device.read` | View device details / status | 20 |
| `device.write` | Modify device settings | 21 |
| `device.connect` | Connect / Disconnect button | 22 |
| `device.start` | Start device button | 23 |
| `device.stop` | Stop device button | 24 |
| `device.start_stop` | Start / Stop controls | 25 |
| `device.control` | Control device operations | 26 |
| `device.add` | Add device button | 27 |
| `device.edit` | Edit device configuration | 28 |
| `device.delete` | Delete device button | 29 |

### 📁 PROJECTS (6 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `project.read` | View projects | 30 |
| `project.write` | Modify projects | 31 |
| `project.create` | Create project / location | 32 |
| `project.rename` | Rename project / location | 33 |
| `project.edit` | Edit project details | 34 |
| `project.delete` | Delete project / location | 35 |

### 📍 LOCATIONS (7 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `location.read` | View locations | 36 |
| `location.write` | Create / edit / delete locations | 37 |
| `location.create` | Create location button | 38 |
| `location.edit` | Edit location button | 39 |
| `location.rename` | Rename location | 40 |
| `location.delete` | Delete location button | 41 |
| `location.move` | Move location to another project | 42 |

### ⚙️ SETTINGS (5 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `settings.read` | View settings | 43 |
| `settings.write` | Modify settings | 44 |
| `settings.edit` | Edit settings button | 45 |
| `settings.reset` | Reset settings to default | 46 |
| `settings.device` | Device-specific settings | 47 |

### ⛽ FUEL MONITORING (3 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `fuel.read` | Read fuel levels | 48 |
| `fuel.view_history` | View fuel history charts | 49 |
| `fuel.view_stats` | View fuel statistics | 50 |

### 👥 USERS (8 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `user.read` | View users | 51 |
| `user.write` | Create / edit / delete users | 52 |
| `user.create` | Create user button | 53 |
| `user.edit` | Edit user details | 54 |
| `user.delete` | Delete user | 55 |
| `user.lock` | Lock / unlock user | 56 |
| `user.reset_password` | Reset user password | 57 |
| `user.assign_role` | Assign role button | 58 |

### 🎭 ROLES (5 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `role.read` | View roles | 59 |
| `role.write` | Create / edit / delete roles | 60 |
| `role.create` | Create role button | 61 |
| `role.edit` | Edit role details | 62 |
| `role.delete` | Delete role button | 63 |

### 🔑 PERMISSIONS (3 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `permission.read` | View permissions | 64 |
| `permission.write` | Manage permissions | 65 |
| `permission.assign` | Assign permissions to roles | 66 |

### 📋 AUDIT (3 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `audit.read` | View audit log | 70 |
| `audit.view` | View audit log (detailed) | 71 |
| `audit.export` | Export audit log | 72 |

### 🏷️ BRANDS (5 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `brand.read` | View device brands | 80 |
| `brand.write` | Create / edit / delete brands | 81 |
| `brand.create` | Create brand button | 82 |
| `brand.edit` | Edit brand button | 83 |
| `brand.delete` | Delete brand button | 84 |

### 📡 TELEMETRY / MONITORING (6 elements)
| Element ID | Label | Sort Order |
|------------|-------|------------|
| `telemetry.read` | View telemetry data | 90 |
| `telemetry.live` | View live telemetry updates | 91 |
| `gps.read` | Read GPS position | 92 |
| `registers.read` | Read Modbus registers | 93 |
| `events.read` | View events log | 94 |
| `events.view` | View event details | 95 |

---

## What Was Added (45 new elements)

### ✅ NEW Categories
- **Authentication** (3 elements) - login, logout, change password
- **Locations** (7 elements) - complete location management
- **Brands** (5 elements) - device brand management
- **Fuel Monitoring** (3 elements) - fuel-specific operations
- **Roles** (5 elements) - role management
- **Permissions** (3 elements) - permission management
- **Telemetry/Monitoring** (6 elements) - live data and GPS

### ✅ Expanded Existing Categories
- **Devices**: Added `device.read`, `device.write`, `device.control`, `device.start`, `device.stop`
- **Projects**: Added `project.read`, `project.write`, `project.edit`
- **Settings**: Added `settings.read`, `settings.write`, `settings.device`
- **Alarms**: Added `alarm.read`, `alarm.snooze`
- **Users**: Added `user.read`, `user.write`
- **Audit**: Added `audit.read`

---

## Usage Instructions

1. **Run the SQL script** in your Oracle database:
   ```bash
   sqlplus MODBUS_ADMIN/password@database @insert-ui-elements-complete.sql
   ```

2. **Expected Result:**
   - 68 rows merged (45 new + 23 updated)
   - Summary report showing element count by category
   - Full list ordered by category

3. **Verify the data:**
   ```sql
   SELECT COUNT(*) FROM MODBUS_ADMIN.UI_ELEMENT_CATALOG;
   -- Should return: 68
   ```

---

## Integration with Permission System

These UI elements can now be:
- ✅ Mapped to permissions in `permission_ui_elements` table
- ✅ Used for role-based access control
- ✅ Referenced in your frontend for showing/hiding UI features
- ✅ Tracked in audit logs

---

## Next Steps

1. **Map permissions to UI elements** - Define which permissions control which UI elements
2. **Update frontend** - Reference these element IDs in your React components
3. **Test access control** - Verify users see only authorized UI elements
4. **Document business rules** - Define which roles should have access to which elements

---

Generated: 2026-07-15
