import { IWorkbenchState } from "../types";

/**
 * Interface specification for objects that represent a perspective, i.e.
 * a saved configuration of panels on the workbench.
 */
export interface IPerspective {

  /**
   * A preferred color to represent the perspective on the UI, in CSS
   * notation.
   */
  color?: string;

  /**
   * The state of the saved perspective, in a form that is suitable for
   * serialization.
   */
  state: IWorkbenchState;

  /**
   * A preferred icon to represent the perspective on the UI.
   */
  icon?: string;

  /**
   * A human-readable name of the perspective.
   */
  label: string;

}
