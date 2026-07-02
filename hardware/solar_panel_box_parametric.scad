/*
  Parametric 3D printable solar panel enclosure.

  Target:
  - Solar panel: 145 x 145 mm
  - Panel pocket: 146.5 x 146.5 x 3 mm
  - Assembled outside size: 168 x 168 x 40 mm
  - FlashForge Creator Pro build volume: 230 x 150 x 150 mm

  OpenSCAD use:
  1. Set `part` below.
  2. Press F6.
  3. Export STL.

  Large 168 x 84 mm pieces fit the bed one at a time.
  The four top-frame rails can be printed together with `part = "print_frame_set"`.
*/

$fn = 72;

// ---------- Select output ----------
part = "assembly";
// part options:
// "assembly", "print_frame_set",
// "top_frame_front", "top_frame_back", "top_frame_left", "top_frame_right",
// "top_lid_left", "top_lid_right",
// "lower_base_front", "lower_base_back",
// "magnet_base_front", "magnet_base_back",
// "print_top_lid_left", "print_top_lid_right",
// "print_lower_base_front", "print_lower_base_back",
// "print_magnet_base_front", "print_magnet_base_back"

explode = 0;        // Set 8..20 for an exploded assembly preview.
show_bed = true;    // Used by print_* views.

// ---------- Main dimensions ----------
outer_x = 168;
outer_y = 168;
outer_z = 40;

panel_actual = 145;
panel_pocket = 146.5;
pocket_depth = 3;

wall = 3.5;
bottom_floor = 4;

cable_w = 12;
cable_h = 8;

magnet_d = 20;
magnet_depth = 3;

m3_clearance = 3.4;
m3_pilot = 2.8;
m3_head_d = 6.5;
m3_head_h = 2.2;

boss_d = 8.5;

// Z stack. 4 + 23 + 7 + 6 = 40 mm assembled height.
mag_base_h = 4;
lower_base_h = 23;
top_lid_base_h = 7;
top_frame_h = 6;
panel_floor_raise = top_frame_h - pocket_depth; // 3 mm.
top_lid_total_h = top_lid_base_h + panel_floor_raise;

// Fit and alignment features.
fit_clearance = 0.25;
lid_tongue_w = 2.0;
lid_tongue_h = 1.2;
frame_tenon_w = 5.5;
frame_tenon_depth = 4;
frame_tenon_h = 3;

eps = 0.05;

frame_margin = (outer_x - panel_pocket) / 2;
rail_center = outer_x / 2 - frame_margin / 2;
screw_offset = 62;
magnet_offset = 52;

assembled_z = mag_base_h + lower_base_h + top_lid_base_h + top_frame_h;
assert(abs(assembled_z - outer_z) < 0.01, "Z stack must equal 40 mm.");
assert(frame_margin > wall, "Panel pocket leaves too little margin.");

mount_points = [
  [-screw_offset, -rail_center], [ screw_offset, -rail_center],
  [-screw_offset,  rail_center], [ screw_offset,  rail_center],
  [-rail_center, -screw_offset], [-rail_center,  screw_offset],
  [ rail_center, -screw_offset], [ rail_center,  screw_offset]
];

magnet_points = [
  [-magnet_offset, -magnet_offset], [ magnet_offset, -magnet_offset],
  [-magnet_offset,  magnet_offset], [ magnet_offset,  magnet_offset]
];

// ---------- Small helpers ----------
module centered_cube(size) {
  translate([-size[0] / 2, -size[1] / 2, 0])
    cube(size);
}

module screw_hole_at(p, d, h, z = -eps) {
  translate([p[0], p[1], z])
    cylinder(d = d, h = h);
}

module screw_holes(points, d, h, z = -eps) {
  for (p = points)
    screw_hole_at(p, d, h, z);
}

module counterbores(points, body_h) {
  for (p = points)
    translate([p[0], p[1], body_h - m3_head_h + eps])
      cylinder(d = m3_head_d, h = m3_head_h + eps);
}

module bed_outline() {
  if (show_bed) {
    color([0.15, 0.15, 0.15, 0.15])
      translate([-230 / 2, -150 / 2, -0.8])
        cube([230, 150, 0.6]);
  }
}

module half_clip_y(front = true, h = 200) {
  translate([-outer_x / 2 - eps,
             front ? -outer_y / 2 - eps : 0,
             -h / 2])
    cube([outer_x + 2 * eps, outer_y / 2 + eps, h]);
}

module half_clip_x(left = true, h = 200) {
  translate([left ? -outer_x / 2 - eps : 0,
             -outer_y / 2 - eps,
             -h / 2])
    cube([outer_x / 2 + eps, outer_y + 2 * eps, h]);
}

// ---------- Top frame: 4 pieces ----------
module top_frame_front_back(front = true) {
  slot_y = front
    ? frame_margin / 2 - frame_tenon_depth
    : -frame_margin / 2;

  difference() {
    centered_cube([outer_x, frame_margin, top_frame_h]);

    // Cable relief through the front rail. It is open, so it prints without support.
    if (front)
      translate([-cable_w / 2, -frame_margin / 2 - eps, -eps])
        cube([cable_w, frame_margin + 2 * eps, top_frame_h + 2 * eps]);

    // M3 clearance holes with shallow top counterbores.
    screw_holes([[-screw_offset, 0], [screw_offset, 0]],
                m3_clearance, top_frame_h + 2 * eps);
    counterbores([[-screw_offset, 0], [screw_offset, 0]], top_frame_h);

    // Matching slots for tenons on the side rails.
    for (sx = [-1, 1])
      translate([sx * rail_center - frame_tenon_w / 2 - fit_clearance / 2,
                 slot_y - fit_clearance / 2,
                 -eps])
        cube([frame_tenon_w + fit_clearance,
              frame_tenon_depth + fit_clearance,
              frame_tenon_h + eps]);
  }
}

module top_frame_side() {
  difference() {
    union() {
      centered_cube([frame_margin, panel_pocket, top_frame_h]);

      // Low tenons slide into the front/back rail slots.
      for (sy = [-1, 1])
        translate([-frame_tenon_w / 2,
                   sy * panel_pocket / 2 + (sy > 0 ? 0 : -frame_tenon_depth),
                   0])
          cube([frame_tenon_w, frame_tenon_depth, frame_tenon_h]);
    }

    screw_holes([[0, -screw_offset], [0, screw_offset]],
                m3_clearance, top_frame_h + 2 * eps);
    counterbores([[0, -screw_offset], [0, screw_offset]], top_frame_h);
  }
}

// ---------- Top lid: 2 pieces ----------
module alignment_ring(width = lid_tongue_w, height = lid_tongue_h, z = 0) {
  // A shallow tongue/groove ring just inside the wall line.
  // Base uses it as a raised tongue; lid subtracts it as a matching groove.
  tongue_x = outer_x - 2 * wall;
  tongue_y = outer_y - 2 * wall;
  y_pos = outer_y / 2 - wall - width / 2;
  x_pos = outer_x / 2 - wall - width / 2;

  translate([0, -y_pos, z])
    centered_cube([tongue_x, width, height]);
  translate([0, y_pos, z])
    centered_cube([tongue_x, width, height]);
  translate([-x_pos, 0, z])
    centered_cube([width, tongue_y, height]);
  translate([x_pos, 0, z])
    centered_cube([width, tongue_y, height]);
}

module top_lid_full() {
  difference() {
    union() {
      // Main cover plate.
      centered_cube([outer_x, outer_y, top_lid_base_h]);

      // Raised panel floor. Top of this pad is 3 mm below the top frame.
      translate([0, 0, top_lid_base_h])
        centered_cube([panel_pocket, panel_pocket, panel_floor_raise]);

    }

    // M3 clearance holes through the lid.
    screw_holes(mount_points, m3_clearance,
                top_lid_total_h + 2 * eps);

    // Matching underside groove for the raised tongue on the lower base.
    alignment_ring(lid_tongue_w + fit_clearance,
                   lid_tongue_h + eps,
                   -eps);

    // Front open wire relief aligns with the front frame and lower base cable notch.
    translate([-cable_w / 2, -outer_y / 2 - eps, -eps])
      cube([cable_w,
            frame_margin + wall + 2 * eps,
            top_lid_total_h + 2 * eps]);
  }
}

module top_lid_half(left = true) {
  intersection() {
    top_lid_full();
    half_clip_x(left, 240);
  }
}

// ---------- Lower base: 2 pieces ----------
module base_shell() {
  difference() {
    centered_cube([outer_x, outer_y, lower_base_h]);
    translate([-outer_x / 2 + wall,
               -outer_y / 2 + wall,
               bottom_floor])
      cube([outer_x - 2 * wall,
            outer_y - 2 * wall,
            lower_base_h - bottom_floor + eps]);
  }
}

module lower_base_full() {
  difference() {
    union() {
      base_shell();

      // Internal bosses for M3 self-tapping screws or heat-set inserts.
      for (p = mount_points)
        translate([p[0], p[1], 0])
          cylinder(d = boss_d, h = lower_base_h);

      alignment_ring(lid_tongue_w, lid_tongue_h, lower_base_h - lid_tongue_h);
    }

    // M3 pilot holes in bosses.
    screw_holes(mount_points, m3_pilot, lower_base_h + 2 * eps);

    // 12 x 8 mm front cable notch, open at the top to avoid support.
    translate([-cable_w / 2,
               -outer_y / 2 - eps,
               lower_base_h - cable_h])
      cube([cable_w, wall + 2 * eps, cable_h + eps]);
  }
}

module lower_base_half(front = true) {
  intersection() {
    lower_base_full();
    half_clip_y(front, 240);
  }
}

// ---------- Magnet base: 2 pieces ----------
module magnet_base_full() {
  difference() {
    centered_cube([outer_x, outer_y, mag_base_h]);

    // Four magnet cups, open on the bottom face. Print this part pocket-side up,
    // then flip it during assembly so the magnets face outward.
    for (p = magnet_points)
      translate([p[0], p[1], -eps])
        cylinder(d = magnet_d, h = magnet_depth + eps);

    // Optional M3 clearance holes aligned to the main assembly screws.
    screw_holes(mount_points, m3_clearance, mag_base_h + 2 * eps);
    for (p = mount_points)
      translate([p[0], p[1], -eps])
        cylinder(d = m3_head_d, h = m3_head_h + eps);
  }
}

module magnet_base_half(front = true) {
  intersection() {
    magnet_base_full();
    half_clip_y(front, 240);
  }
}

// ---------- Assembly and print layouts ----------
module assembly_view() {
  z_base = mag_base_h;
  z_lid = mag_base_h + lower_base_h;
  z_frame = mag_base_h + lower_base_h + top_lid_base_h;

  color([0.29, 0.33, 0.39])
    translate([0, -explode, 0])
      magnet_base_half(true);
  color([0.29, 0.33, 0.39])
    translate([0, explode, 0])
      magnet_base_half(false);

  color([0.18, 0.50, 0.93])
    translate([0, -explode, z_base])
      lower_base_half(true);
  color([0.18, 0.50, 0.93])
    translate([0, explode, z_base])
      lower_base_half(false);

  color([0.15, 0.68, 0.38])
    translate([-explode, 0, z_lid])
      top_lid_half(true);
  color([0.15, 0.68, 0.38])
    translate([explode, 0, z_lid])
      top_lid_half(false);

  color([0.95, 0.60, 0.29])
    translate([0, -rail_center - explode, z_frame])
      top_frame_front_back(true);
  color([0.95, 0.60, 0.29])
    translate([0, rail_center + explode, z_frame])
      top_frame_front_back(false);
  color([0.95, 0.60, 0.29])
    translate([-rail_center - explode, 0, z_frame])
      top_frame_side();
  color([0.95, 0.60, 0.29])
    translate([rail_center + explode, 0, z_frame])
      top_frame_side();

  // Transparent reference panel.
  color([0.1, 0.1, 0.1, 0.22])
    translate([0, 0, outer_z - pocket_depth])
      centered_cube([panel_actual, panel_actual, pocket_depth]);
}

module print_frame_set() {
  bed_outline();

  translate([0, -56, 0])
    top_frame_front_back(true);
  translate([0, -39, 0])
    top_frame_front_back(false);

  translate([-38, 34, 0])
    rotate([0, 0, 90])
      top_frame_side();
  translate([38, 34, 0])
    rotate([0, 0, 90])
      top_frame_side();
}

module print_large_part(kind = "lid_left") {
  bed_outline();

  if (kind == "lid_left")
    translate([outer_x / 4, 0, 0])
      top_lid_half(true);
  else if (kind == "lid_right")
    translate([-outer_x / 4, 0, 0])
      top_lid_half(false);
  else if (kind == "base_front")
    translate([0, outer_y / 4, 0])
      lower_base_half(true);
  else if (kind == "base_back")
    translate([0, -outer_y / 4, 0])
      lower_base_half(false);
  else if (kind == "mag_front")
    translate([0, outer_y / 4, mag_base_h])
      rotate([180, 0, 0])
        magnet_base_half(true);
  else if (kind == "mag_back")
    translate([0, -outer_y / 4, mag_base_h])
      rotate([180, 0, 0])
        magnet_base_half(false);
}

// ---------- Output switch ----------
if (part == "assembly")
  assembly_view();
else if (part == "print_frame_set")
  print_frame_set();
else if (part == "top_frame_front")
  top_frame_front_back(true);
else if (part == "top_frame_back")
  top_frame_front_back(false);
else if (part == "top_frame_left")
  top_frame_side();
else if (part == "top_frame_right")
  top_frame_side();
else if (part == "top_lid_left")
  translate([outer_x / 4, 0, 0])
    top_lid_half(true);
else if (part == "top_lid_right")
  translate([-outer_x / 4, 0, 0])
    top_lid_half(false);
else if (part == "lower_base_front")
  translate([0, outer_y / 4, 0])
    lower_base_half(true);
else if (part == "lower_base_back")
  translate([0, -outer_y / 4, 0])
    lower_base_half(false);
else if (part == "magnet_base_front")
  translate([0, outer_y / 4, 0])
    magnet_base_half(true);
else if (part == "magnet_base_back")
  translate([0, -outer_y / 4, 0])
    magnet_base_half(false);
else if (part == "print_top_lid_left")
  print_large_part("lid_left");
else if (part == "print_top_lid_right")
  print_large_part("lid_right");
else if (part == "print_lower_base_front")
  print_large_part("base_front");
else if (part == "print_lower_base_back")
  print_large_part("base_back");
else if (part == "print_magnet_base_front")
  print_large_part("mag_front");
else if (part == "print_magnet_base_back")
  print_large_part("mag_back");
else
  assembly_view();
